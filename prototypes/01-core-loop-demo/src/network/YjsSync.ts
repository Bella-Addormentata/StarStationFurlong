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

export class YjsSync {
  readonly doc: Y.Doc;

  constructor(private readonly opts: YjsSyncOptions) {
    this.doc = new Y.Doc();
  }

  /** Kick off the y-sync state machine over the reliable channel:
   *  write SyncStep1(doc state vector), answer inbound SyncStep1/2/Update. */
  async start(): Promise<void> {
    // Sprint 3: y-protocols sync read/write loop over this.opts.channel,
    // wrapped in SsfEnvelope{kind:'ysync'} frames. y-indexeddb for instant
    // local-first load before the first peer connects.
    throw new Error(`YjsSync.start(${this.opts.roomId}) — not implemented yet (Sprint 3)`);
  }

  async stop(): Promise<void> {
    this.doc.destroy();
  }
}
