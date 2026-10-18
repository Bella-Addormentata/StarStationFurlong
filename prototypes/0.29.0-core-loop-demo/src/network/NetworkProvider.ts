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
import { buildRoomCapPayload, memberCardsOf, nextCapSeq, readChiaMode, readShareCard } from './roomCap.ts';
import type { FaucetOp, FaucetRequestTicket } from '../faucetDish.ts';

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
  /** Replies to our own `faucet` requests: delivered ONLY from the stream the
   *  request went out on, never from a node-opened stream (a peer's forwarded
   *  envelope must not pass for the node's answer). */
  #faucetReplyHandler: ((env: any) => void) | null = null;
  /** Monotonic `seq` on faucet requests; the node echoes it on the reply, so
   *  the dish can tell the reply to its pending TAKE/GIVE from any other (each
   *  request is its own stream, and streams complete in any order). */
  #faucetSeq = 0;
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
  /** N8 probe: is this room public space? Installed by main.ts. */
  #publicRoomProbe: ((roomId: string) => boolean | undefined) | null = null;
  /** Last cap `seq` sent (see roomCap.ts): caps ride separate streams. */
  #capSeq = 0;

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

      // Superseded while dialing? disconnect() — and perhaps a newer connect() —
      // ran during the handshake, and a handshake can still COMPLETE after that.
      // This dial no longer owns the provider, so it must not touch anything
      // shared: setting the mode, taking the datagram writer or starting the
      // loops here would hijack the live session (its ticks would go out on
      // this dead transport). Shut what we opened and say so.
      if (this.#wt !== wt) {
        try { wt.close(); } catch { /* disconnect() already closed it */ }
        throw new Error('WebTransport dial superseded by a newer session');
      }
      
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

      // 4. ChiaHub Slice 3: hand our LOCAL node this room's key + flags over a
      // one-shot `cap` stream, so it can derive the room's chia lookup hint,
      // read presence for it (on by default, #231 D3) and publish presence when
      // armed. Loopback only. The chia-mode flag is the "advanced chia mesh
      // mode" toggle — sourced from localStorage until the management-computer
      // UI sets it; the public-room flag (N8) comes from the probe main.ts
      // installs and is re-sent whenever the door policy changes.
      if (boot.roomKeyB64) {
        void this.sendRoomCap(boot.roomId, boot.roomKeyB64, readChiaMode(boot.roomId));
      }

    } catch (err: any) {
      // Only the dial that still OWNS the session may take it offline. A dial
      // abandoned by disconnect() ends up here later (its transport was closed
      // under it, or it found itself superseded above) — possibly after a NEWER
      // connect() has come up on this same provider, and resetting the shared
      // state then would silently mute that live session (sendTick no-ops while
      // the mode reads offline). An abandoned dial is not a failure to report
      // either: whoever called disconnect() meant it. `wt` still null means the
      // transport could not even be constructed — that one is ours.
      const superseded = wt !== null && this.#wt !== wt;
      if (!superseded) {
        console.error(`⚠️ WebTransport handshaking failed:`, err);
        this.#mode = 'offline';
        this.#isActive = false;
        this.#datagramWriter = null;
        // Leave no half-open transport behind for openChannel to trip over.
        try { wt?.close(); } catch { /* never opened, or already gone */ }
        this.#wt = null;
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
   *  new. Fire-and-forget. The payload also carries N8's `publicRoom` flag from
   *  the installed probe (`null` while the probe cannot say yet, #272 review
   *  round 3); a provider with no probe (every background provider)
   *  sends no cap at all — see the guard below. Same `[u32-LE len][JSON]`
   *  framing the node reads on every browser->node stream. */
  async sendRoomCap(roomId: string, roomKeyB64: string, chiaMode: boolean): Promise<void> {
    if (!this.#wt || this.#mode === 'offline') return;
    // N8: only a provider that can vouch for the room's posture speaks. The
    // background providers (passes, far-door and departure writes, direct
    // messages, room sessions) have no probe; a cap from one of them would
    // overwrite the primary session's reading for that room with a blanket
    // PUBLIC — fail-closed, but it would switch reads off for a room the
    // player is standing in. The node holds no cap for a room nobody vouched
    // for, which is the same fail-closed outcome without the override.
    if (!this.#publicRoomProbe) return;
    try {
      const publicRoom = this.#publicRoomProbe(roomId);
      this.#capSeq = nextCapSeq(this.#capSeq);
      // #231 P6b: the room's share-my-card toggle and the cards its pass
      // carries for its members (this session's boot, when it is this room's).
      const boot = this.#boot;
      const memberCards = boot?.roomId === roomId ? memberCardsOf(boot.memberHints) : [];
      const payload = buildRoomCapPayload(roomKeyB64, chiaMode, publicRoom, this.#capSeq, readShareCard(roomId), memberCards);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      // A few KB at most (member cards); chunked so the spread never trips an
      // argument limit. Node decodes with BASE64_STANDARD, which btoa produces.
      let payloadText = '';
      for (let i = 0; i < payloadBytes.length; i += 0x8000) {
        payloadText += String.fromCharCode(...payloadBytes.subarray(i, i + 0x8000));
      }
      const payloadB64 = btoa(payloadText);
      const wire = { v: 1, room: roomId, kind: 'cap', seq: 0, author: '', payload: payloadB64 };
      const jsonBytes = new TextEncoder().encode(JSON.stringify(wire));
      const packet = new Uint8Array(4 + jsonBytes.length);
      new DataView(packet.buffer).setUint32(0, jsonBytes.length, true);
      packet.set(jsonBytes, 4);
      const stream = await this.#wt.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(packet);
      // close() sends FIN: the node's reader sees EOF and ends its stream task.
      // Only releasing the lock left every cap stream open until disconnect.
      await writer.close();
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

  /** N8: who decides whether a room is public space (bundled seed or PUBLIC
   *  passage). main.ts installs it on the primary provider at boot, before any
   *  join; a provider without one never sends a cap, so a node never publishes
   *  under a key the browser has not vouched for. */
  setPublicRoomProbe(probe: (roomId: string) => boolean | undefined): void {
    this.#publicRoomProbe = probe;
  }

  /** Re-send the current room's cap with its CURRENT flags — called when the
   *  door policy changes, so a room flipping between public and private passage
   *  reaches the node without a reconnect. */
  async refreshRoomCap(): Promise<void> {
    const boot = this.#boot;
    if (boot?.roomKeyB64) {
      await this.sendRoomCap(boot.roomId, boot.roomKeyB64, readChiaMode(boot.roomId));
    }
  }

  /** ⛓️🥣 Ask the LOCAL node about this room's faucet dish — `status` (what is
   *  in the jar and the dish), `claim` (take the ready mojo to our wallet) or
   *  `give` (pay `amount` mojos from our wallet into the jar). One fresh
   *  bidirectional stream per request, the `cap` framing; the node answers on
   *  that stream with a `faucet` envelope, which arrives through onFaucetReply
   *  and nowhere else. The node derives the faucet address from the room key
   *  it already holds from `cap`, so nothing secret travels here.
   *
   *  Returns the request's `seq` at once, with `sent`: a promise that resolves
   *  once the request is on the wire and REJECTS when it never left (no node
   *  connection, or the stream failed before the frame was written), so the
   *  caller can drop its pending TAKE/GIVE at once. The seq is allotted here,
   *  before anything is written, so the dish keys the pending action on it
   *  before any reply can arrive. A failure AFTER the write is indeterminate
   *  and resolves (see below).
   *
   *  The reply is accepted only while the transport this request went out on
   *  is still the live one: a stream of a session since left can outlive
   *  disconnect() (its read is still pending), and a reconnect that lands the
   *  same room before it ends must not take that session's stale status or
   *  error as its own. */
  requestFaucet(op: FaucetOp, amount?: number): FaucetRequestTicket {
    const seq = ++this.#faucetSeq;
    return { seq, sent: this.#sendFaucetRequest(op, amount, seq) };
  }

  async #sendFaucetRequest(op: FaucetOp, amount: number | undefined, seq: number): Promise<void> {
    const boot = this.#boot;
    const wt = this.#wt;
    if (!wt || this.#mode === 'offline' || !boot) {
      throw new Error('no connection to your node');
    }
    try {
      const body: { op: FaucetOp; amount?: number } = { op };
      if (op === 'give') body.amount = Math.max(0, Math.floor(amount ?? 0));
      const payloadBytes = new TextEncoder().encode(JSON.stringify(body));
      const payloadB64 = btoa(String.fromCharCode(...payloadBytes));
      const wire = { v: 1, room: boot.roomId, kind: 'faucet', seq, author: '', payload: payloadB64 };
      const jsonBytes = new TextEncoder().encode(JSON.stringify(wire));
      const packet = new Uint8Array(4 + jsonBytes.length);
      new DataView(packet.buffer).setUint32(0, jsonBytes.length, true);
      packet.set(jsonBytes, 4);
      const stream = await wt.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(packet);
      // One request per stream: close() sends FIN, so after its reply the node
      // finishes its side too and this stream ends instead of living (and
      // holding a node task) until disconnect — one leak per status poll.
      // The frame is on the wire once write() resolves, so a close() that fails
      // (a reset while the FIN is in flight) is a failure of the stream's
      // cleanup, not of the request: the node may well have read the frame and
      // be acting on it. It is logged, the reply is still awaited, and the
      // request is NOT reported as never sent — that would drop a pending
      // TAKE/GIVE and invite a second one.
      try {
        await writer.close();
      } catch (e) {
        console.warn('Faucet request stream did not close cleanly (the node may still answer):', e);
      }
      // The reply comes back on THIS stream, and only a reply is accepted from
      // it: the generic envelope path never sees it, and nothing that arrives
      // on a node-opened stream can pass for it. Bound to `wt`: the drain
      // stops delivering the moment that transport is no longer the live one.
      void this.#drainNodeStream(stream, wt, (env) => {
        if (env?.kind === 'faucet') this.#faucetReplyHandler?.(env);
      });
    } catch (e) {
      console.warn('Failed to send faucet request to node:', e);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Register a handler for envelopes arriving on node-initiated streams
   *  (remote peers' ysync updates, bridge dial-status, future chat lanes). */
  onEnvelope(handler: (env: any) => void): void {
    this.#envelopeHandler = handler;
  }

  /** Register the handler for the node's replies to requestFaucet. */
  onFaucetReply(handler: (env: any) => void): void {
    this.#faucetReplyHandler = handler;
  }

  /** Accept and drain every bidirectional stream the NODE opens toward us.
   *  Each stream carries u32-LE length-framed JSON SsfEnvelopes (same wire
   *  format as browser→node streams). */
  async #listenIncomingStreams(): Promise<void> {
    // THIS session's transport: every stream it hands us is drained for as long
    // as it stays the live one, and not a read longer.
    const wt = this.#wt;
    if (!wt) return;
    try {
      const reader = wt.incomingBidirectionalStreams.getReader();
      while (this.#isActive && this.#wt === wt) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        this.#openChannels++;
        void this.#drainNodeStream(stream, wt);
      }
    } catch (e) {
      if (this.#isActive) {
        console.warn('Incoming-stream acceptor stopped:', e);
      }
    }
  }

  /** Read length-framed envelopes off `stream` until it ends. Node-opened
   *  streams deliver to the generic handler; a request stream we opened passes
   *  its own `deliver`, so its replies never mix with forwarded traffic.
   *
   *  `owner` is the transport the stream belongs to. A read already pending
   *  when disconnect() runs resolves later — possibly after a reconnect has
   *  made the provider active again on a NEW transport — and what it read then
   *  belongs to the session that was left, not to the live one: nothing is
   *  delivered, and the drain ends, once `owner` is no longer `this.#wt`. */
  async #drainNodeStream(
    stream: { readable: ReadableStream<Uint8Array> },
    owner: unknown,
    deliver: (env: any) => void = (env) => this.#envelopeHandler?.(env),
  ): Promise<void> {
    const reader = stream.readable.getReader();
    let buffer = new Uint8Array(0);
    const live = (): boolean => this.#isActive && this.#wt === owner;
    try {
      while (live()) {
        const { value, done } = await reader.read();
        if (done || !live()) break;
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
            deliver(envelope);
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
