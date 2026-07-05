/**
 * RoomLog — append-only social-log port stub (chat history, bulletin boards,
 * contracts). The seam exists from day one; the adapter lands Phase 2 after
 * the v006 §15.1 #3 substrate bakeoff (p2panda vs SsfLog) AND the §7
 * Trust & Safety design-note gate.
 *
 * Phase 1: durable social state stays in the Yjs demo doc (ChatProvider
 * backend 'yjs-demo'); this class only pins the contract.
 */
import type { ModerationView, OpId, RoomLogOp, RoomLogPort, SealRef } from './protocol.ts';

export class RoomLog implements RoomLogPort {
  async append(_kind: string, _body: Uint8Array): Promise<OpId> {
    throw new Error('RoomLog.append — Phase 2 adapter (v006 §5.4, T&S-gated §7)');
  }

  // eslint-disable-next-line require-yield
  async *subscribe(_from?: SealRef): AsyncIterable<RoomLogOp> {
    throw new Error('RoomLog.subscribe — Phase 2 adapter (v006 §5.4)');
  }

  moderation(): ModerationView {
    // Subjective, client-local mute/block over per-writer logs (v006 §7).
    const muted = new Set<string>();
    const key = (w: Uint8Array) => Array.from(w).join(',');
    return {
      mute: (w) => void muted.add(key(w)),
      unmute: (w) => void muted.delete(key(w)),
      isMuted: (w) => muted.has(key(w)),
    };
  }

  async sealHead(): Promise<SealRef | undefined> {
    return undefined; // Station Seals land Phase 3 (v006 §6)
  }
}
