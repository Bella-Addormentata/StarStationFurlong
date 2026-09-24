/**
 * ⚓ Far-room dock writes (#163)
 *
 * DOCK and UNDOCK change BOTH ends of a docking adapter, but only one room doc
 * is bound at a time — which is why every undock before this was one-sided,
 * and why the spaceship plan (§5.1) had accepted a station that keeps drawing
 * a ship that already left. This closes that gap where it can:
 *
 *   a short-lived background session to the FAR room's doc — the roomPasses
 *   prefetch pattern: its own NetworkProvider + YjsSync on the local node —
 *   waits until the far replica holds real state, applies ONE decision
 *   (dockRules: compare-and-swap on the far door's record), waits for the
 *   node's acknowledgment (YjsSync.confirmOwnWrites), and hangs up.
 *
 * Best effort by design: an unreachable far room is REPORTED (the caller says
 * so), never retried behind the player's back. Serialized per far room, so a
 * quick UNDOCK → DOCK lands in order. The decision half is pure over a Y.Doc
 * (applyFarDockRequest) and pinned by farDoorWrite.test.ts.
 */

import * as Y from 'yjs';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import type { RoomBootstrap } from './network/protocol';
import { ysyncSigner } from './keypair';
import { readAllDoorsFrom, writeDoorRecordTo } from './doorsDoc';
import { fitDockPortIn } from './doorPolicy';
import { doorExistsIn } from './doorLayoutDoc';
import {
  farDockPatch, farUndockPatch, findFarDoor, type NearEnd,
} from './dockRules';
import type { FarDockRequest, FarDockResult } from './docking';

// ── The decision (pure over a doc) ───────────────────────────────────────────

/**
 * Apply one DOCK / UNDOCK to the far room's doc. Returns what to tell the
 * player and whether anything was written (only a write needs an ack).
 */
export function applyFarDockRequest(
  doc: Y.Doc,
  req: FarDockRequest,
  near: NearEnd,
): { result: FarDockResult; wrote: boolean } {
  const doors = readAllDoorsFrom(doc);
  if (req.kind === 'undock') {
    const farDoor = findFarDoor(doors, near.roomId, near.doorId, req.farDoor);
    if (!farDoor) return { result: { ok: true, detail: 'nothing-to-undo' }, wrote: false };
    const patch = farUndockPatch(doors.get(farDoor), near, req.undockedAt);
    if (patch.action === 'skip') {
      return { result: { ok: true, detail: 'nothing-to-undo' }, wrote: false };
    }
    writeDoorRecordTo(doc, farDoor, patch.record);
    return { result: { ok: true, detail: 'written' }, wrote: true };
  }
  const patch = farDockPatch(
    doors.get(req.farDoor),
    doorExistsIn(doc, req.farDoor),
    near,
    req.dockedAt,
  );
  if (patch.action === 'refuse') {
    return { result: { ok: false, reason: patch.reason }, wrote: false };
  }
  // One transaction: the berth's record and its port land together, so no
  // peer ever sees a dock on a door without its half.
  doc.transact(() => {
    writeDoorRecordTo(doc, req.farDoor, patch.record);
    fitDockPortIn(doc, req.farDoor);
  });
  return { result: { ok: true, detail: 'written' }, wrote: true };
}

// ── The session ──────────────────────────────────────────────────────────────

export interface FarDoorWriteDeps {
  /** Decode a pass / link into a bootstrap (null if unreadable). */
  decode: (seed: string) => RoomBootstrap | null;
  /** Rewrite it onto the LOCAL node, keeping the room key + host hints. */
  resolve: (boot: RoomBootstrap) => Promise<RoomBootstrap>;
}

let deps: FarDoorWriteDeps | null = null;

export function initFarDoorWrite(d: FarDoorWriteDeps): void {
  deps = d;
}

/** How long the far room's state may take to arrive (dial + sync). */
const READY_TIMEOUT_MS = 10_000;
/** How long the node may take to acknowledge the write. */
const ACK_TIMEOUT_MS = 5_000;
/** Re-ask for state this often while waiting (a cross-node host links late). */
const RESYNC_EVERY_MS = 2_000;

/** One far write at a time per far room. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Tell the far room. `near` describes this end of the connection. Never
 * throws: every failure is a FarDockResult the caller can show.
 */
export function writeFarDock(req: FarDockRequest, near: NearEnd): Promise<FarDockResult> {
  const d = deps;
  if (!d) return Promise.resolve({ ok: false, reason: 'unreachable' });
  const imported = d.decode(req.farAddress);
  if (!imported) return Promise.resolve({ ok: false, reason: 'no-address' });
  // A dock between two doors of ONE module has no far room to tell.
  if (imported.roomId === near.roomId) {
    return Promise.resolve({ ok: true, detail: 'nothing-to-undo' });
  }
  const key = imported.roomId;
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => session(d, imported, req, near),
    () => session(d, imported, req, near),
  );
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function session(
  d: FarDoorWriteDeps,
  imported: RoomBootstrap,
  req: FarDockRequest,
  near: NearEnd,
): Promise<FarDockResult> {
  let provider: NetworkProvider | null = null;
  let sync: YjsSync | null = null;
  try {
    const boot = await d.resolve(imported);
    provider = new NetworkProvider();
    const p = provider;
    await withTimeout(p.connect(boot), READY_TIMEOUT_MS, 'far room dial');
    const channel = await p.openChannel('ysync');
    sync = new YjsSync({
      roomId: boot.roomId,
      channel,
      ...ysyncSigner(),
      // THIS room's dial hints on our envelopes — never the active room's
      // (the same review-HIGH trap roomPasses documents).
      bootRecord: () => p.getBootRecord(),
    });
    const s = sync;
    p.onEnvelope((env: { kind?: string; room?: string; payload?: string }) => {
      if (env.kind === 'ysync') {
        s.ingestEnvelope(env);
        return;
      }
      if (env.kind === 'bridge' && typeof env.payload === 'string') {
        try {
          if (JSON.parse(atob(env.payload))?.status === 'connected') {
            s.markPeerLinked();
            s.resync();
          }
        } catch {
          /* non-JSON bridge payload */
        }
      }
    });
    await s.start();
    if (!(await roomStateArrived(s, READY_TIMEOUT_MS))) {
      console.warn(`[farDoorWrite] ${boot.roomId}: no room state within ${READY_TIMEOUT_MS} ms`);
      return { ok: false, reason: 'unreachable' };
    }
    // Read-before-write: the decision sees the far room's real state, so the
    // write is causally AFTER the record it replaces and wins everywhere.
    const since = Y.encodeStateVector(s.doc);
    const { result, wrote } = applyFarDockRequest(s.doc, req, near);
    if (wrote && !(await s.confirmOwnWrites(since, ACK_TIMEOUT_MS))) {
      console.warn(`[farDoorWrite] ${boot.roomId}: the node did not acknowledge the write`);
      return { ok: false, reason: 'unreachable' };
    }
    console.log(
      `⚓ Far dock write → ${boot.roomId}: ${req.kind} ${result.ok ? result.detail : result.reason}`,
    );
    return result;
  } catch (err) {
    console.warn('[farDoorWrite] far room session failed:', err);
    return { ok: false, reason: 'unreachable' };
  } finally {
    try {
      await sync?.stop();
    } catch {
      /* the doc may be gone */
    }
    try {
      await provider?.disconnect();
    } catch {
      /* the transport may be gone */
    }
  }
}

/** The transit curtain's rule (main.ts initialRoomStateReady), for a doc that
 *  is not the active one: a post-link sync from the host, or the room's
 *  owner + name. Until then the replica is EMPTY, and an empty replica is not
 *  knowledge about the room — a decision made on it could overwrite a record
 *  it simply had not received yet. */
function roomStateArrived(sync: YjsSync, timeoutMs: number): Promise<boolean> {
  const roomMap = sync.doc.getMap('roomInfo');
  const ready = () => sync.linkedSynced || (roomMap.has('owner') && roomMap.has('name'));
  if (ready()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const started = Date.now();
    let lastResync = started;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        roomMap.unobserve(onChange);
      } catch {
        /* doc destroyed */
      }
      resolve(ok);
    };
    const onChange = () => {
      if (ready()) finish(true);
    };
    roomMap.observe(onChange);
    void sync.whenLinkedSynced.then(() => finish(true));
    const tick = () => {
      if (done) return;
      if (ready()) return finish(true);
      const now = Date.now();
      if (now - started >= timeoutMs) return finish(false);
      if (now - lastResync >= RESYNC_EVERY_MS) {
        lastResync = now;
        sync.resync();
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
