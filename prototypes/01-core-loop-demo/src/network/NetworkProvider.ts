/**
 * NetworkProvider — transport port skeleton (Sprint 3 implements this).
 *
 * Primary adapter: raw WebTransport + serverCertificateHashes dial to a
 * player-run Tauri node (v006 §5.1 / Phase 1 Task 3.2). No simple-peer,
 * no signaling — the join string is URL + certhash (+ challenge).
 *
 * Sprint-3 acceptance criteria live in Phase1-ExecutionPlan Task 3.2.
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

export class NetworkProvider implements NetworkProviderPort {
  #mode: TransportMode = 'offline';
  #durability: DurabilityState = { replicas: 0, sealedEpoch: 0, pinned: false };
  #stats: NetworkStats = { rttMs: NaN, loss: NaN };

  async connect(_boot: RoomBootstrap): Promise<void> {
    // Sprint 3 Task 3.2:
    //  1. new WebTransport(boot.wtUrl, { serverCertificateHashes: [...] })
    //     — first LAN dial from page context (Chromium 142/147 LNA prompt, v006 §3.8)
    //  2. answer boot.challenge over the 'cap' channel (ClientHello → NodeAck)
    //  3. start the ping/pong probe on datagrams (#stats)
    //  4. set #mode from datagram availability
    throw new Error('NetworkProvider.connect — not implemented yet (Sprint 3)');
  }

  async disconnect(): Promise<void> {
    this.#mode = 'offline';
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

  sendTick(_buf: Uint8Array): void {
    // Datagram lane — fire-and-forget 13-byte packTick() output.
    // NEVER route position through awareness (v006 §8.1 three-lane rule).
    throw new Error('NetworkProvider.sendTick — not implemented yet (Sprint 3)');
  }

  onTick(_handler: (buf: Uint8Array) => void): void {
    throw new Error('NetworkProvider.onTick — not implemented yet (Sprint 3)');
  }

  async openChannel(
    _kind: Exclude<EnvelopeKind, 'tick' | 'ping' | 'pong'>,
  ): Promise<ByteDuplex> {
    // One reliable bidi WT stream per kind, framed with SsfEnvelope.
    throw new Error('NetworkProvider.openChannel — not implemented yet (Sprint 3)');
  }
}
