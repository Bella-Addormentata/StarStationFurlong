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
 *   waits until the far replica holds real state (for a room hosted
 *   elsewhere: a fresh answer from its live host, never the node's cached
 *   copy), applies ONE decision (dockRules: compare-and-swap on the far
 *   door's record), waits for the node's acknowledgment
 *   (YjsSync.confirmOwnWrites), and — for a DOCK, which is not a lock —
 *   lets concurrent claims on the same berth settle and checks it is still
 *   the one the berth names (berthAfterSettle). Then it hangs up.
 *
 * Best effort by design: an unreachable far room is REPORTED (the caller says
 * so), never retried behind the player's back. Serialized per far room, so a
 * quick UNDOCK → DOCK lands in order. The decision half is pure over a Y.Doc
 * (applyFarDockRequest, berthAfterSettle, roomStateReady) and pinned by
 * farDoorWrite.test.ts. What no client can close alone: a claim that reaches
 * the berth only AFTER the settle window — exactly-once arbitration needs an
 * authority for the berth (the room host arbitrating claims, the #67 D3
 * owner-authority direction).
 */

import * as Y from 'yjs';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import type { RoomBootstrap } from './network/protocol';
import { ysyncSigner } from './keypair';
import { readAllDoorsFrom, readDoorFrom, writeDoorRecordTo } from './doorsDoc';
import { dockPortFlagIn, fitDockPortIn } from './doorPolicy';
import { doorExistsIn } from './doorLayoutDoc';
import {
  farDockPatch, farUndockPatch, findFarDoor, holdsDockTo, type NearEnd,
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
  if (req.kind === 'undock') {
    // A named door is read on its own (readDoorFrom — the capped snapshot
    // could hide it); the snapshot only serves the scan when none is named.
    const farDoor =
      req.farDoor || findFarDoor(readAllDoorsFrom(doc), near.roomId, near.doorId);
    if (!farDoor) return { result: { ok: true, detail: 'nothing-to-undo' }, wrote: false };
    const patch = farUndockPatch(readDoorFrom(doc, farDoor), near, req.undockedAt, req.onlyDockedAt);
    if (patch.action === 'skip') {
      return { result: { ok: true, detail: 'nothing-to-undo' }, wrote: false };
    }
    writeDoorRecordTo(doc, farDoor, patch.record);
    return { result: { ok: true, detail: 'written' }, wrote: true };
  }
  const patch = farDockPatch(readDoorFrom(doc, req.farDoor), farBerth(doc, req.farDoor), near, req.dockedAt);
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

/** What farDockPatch needs to know about the far door besides its record. */
function farBerth(doc: Y.Doc, farDoor: string): { exists: boolean; portFlag: boolean } {
  return { exists: doorExistsIn(doc, farDoor), portFlag: dockPortFlagIn(doc, farDoor) };
}

/**
 * A DOCK's far write is not a lock. Another module can read the same free
 * berth, write its own claim concurrently, and have it acknowledged too; the
 * CRDT then keeps exactly ONE of the two — the same one on every replica. So,
 * once concurrent writes have had a settle window to arrive (the session calls
 * this after it), only the writer the berth still names has docked: this
 * returns null for it, and the refusal to report for anyone else, whose own
 * side must then stay undocked. Pure over the far doc.
 */
export function berthAfterSettle(
  doc: Y.Doc,
  req: Extract<FarDockRequest, { kind: 'dock' }>,
  near: NearEnd,
): FarDockResult | null {
  const record = readDoorFrom(doc, req.farDoor);
  if (holdsDockTo(record, near)) return null;
  const now = farDockPatch(record, farBerth(doc, req.farDoor), near, req.dockedAt);
  return { ok: false, reason: now.action === 'refuse' ? now.reason : 'occupied' };
}

/** The readiness rule for the far room's replica. A room hosted on THIS
 *  machine's node: the transit curtain's rule (a post-link sync, or the room's
 *  owner + name). A room hosted elsewhere: only a fresh, verified frame from
 *  the live host — the local node may be answering from a stale cached copy,
 *  and a decision on that could clobber a berth that has since changed. */
export function roomStateReady(s: {
  linkedSynced: boolean;
  hasOwnerAndName: boolean;
  hostedHere: boolean;
}): boolean {
  return s.linkedSynced || (s.hostedHere && s.hasOwnerAndName);
}

// ── The session ──────────────────────────────────────────────────────────────

export interface FarDoorWriteDeps {
  /** Decode a pass / link into a bootstrap (null if unreadable). */
  decode: (seed: string) => RoomBootstrap | null;
  /** Rewrite it onto the LOCAL node, keeping the room key + host hints. */
  resolve: (boot: RoomBootstrap) => Promise<RoomBootstrap>;
  /** Is this room hosted by THIS machine's node (our home, or a module we
   *  minted)? Then our node's replica is the room's own copy; otherwise only
   *  a fresh frame from the live host counts (roomStateReady). */
  hostedHere: (roomId: string) => boolean;
  /** The bound doc when `roomId` is the room this client stands in — where
   *  a dock between two doors of ONE module keeps its far end. */
  activeRoomDoc: (roomId: string) => Y.Doc | null;
}

let deps: FarDoorWriteDeps | null = null;

export function initFarDoorWrite(d: FarDoorWriteDeps): void {
  deps = d;
}

/** How long the far room's state may take to arrive (dial + sync). */
const READY_TIMEOUT_MS = 10_000;
/** …for a room hosted elsewhere, whose live host must answer (a P2P dial). */
const HOST_READY_TIMEOUT_MS = 20_000;
/** How long the node may take to acknowledge the write. */
const ACK_TIMEOUT_MS = 5_000;
/** How long a DOCK waits for concurrent claims on the same berth to arrive
 *  before it believes it holds it (berthAfterSettle). */
const SETTLE_MS = 1_500;
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
  // A dock between two doors of ONE module: its far end is the OTHER door of
  // the room this client stands in. Same decision, applied to the bound doc —
  // no session to open, and no other replica of that door to wait for.
  if (imported.roomId === near.roomId) {
    const doc = d.activeRoomDoc(near.roomId);
    if (!doc) return Promise.resolve({ ok: false, reason: 'unreachable' });
    return Promise.resolve(applyFarDockRequest(doc, req, near).result);
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
    const hostedHere = d.hostedHere(boot.roomId);
    // A room hosted elsewhere is known only from its live host. Arm the gate
    // now — the bridge may already be linked by another session, and then no
    // `connected` status ever reaches this one: the next VERIFIED frame from
    // another author (the host answering a resync) opens it. The node's own
    // answers are unsigned, so a stale cached replica never does.
    if (!hostedHere) s.markPeerLinked();
    const readyWithin = hostedHere ? READY_TIMEOUT_MS : HOST_READY_TIMEOUT_MS;
    if (!(await roomStateArrived(s, readyWithin, hostedHere))) {
      console.warn(
        `[farDoorWrite] ${boot.roomId}: no ${hostedHere ? 'room state' : 'answer from its host'} within ${readyWithin} ms`,
      );
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
    if (wrote && req.kind === 'dock') {
      // Concurrent claims on the same berth get a moment to arrive (they are
      // applied to this doc as they do); then only the claim the CRDT kept
      // has docked.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const lost = berthAfterSettle(s.doc, req, near);
      if (lost) {
        console.warn(
          `[farDoorWrite] ${boot.roomId}: another claim on ${req.farDoor} won the berth (${lost.ok ? '' : lost.reason})`,
        );
        return lost;
      }
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

/** Wait for roomStateReady on a doc that is not the active one. Until it
 *  holds, the replica is EMPTY (or, for a room hosted elsewhere, possibly
 *  STALE), and neither is knowledge about the room — a decision made on it
 *  could overwrite a record it simply had not received yet. */
function roomStateArrived(sync: YjsSync, timeoutMs: number, hostedHere: boolean): Promise<boolean> {
  const roomMap = sync.doc.getMap('roomInfo');
  const ready = () =>
    roomStateReady({
      linkedSynced: sync.linkedSynced,
      hasOwnerAndName: roomMap.has('owner') && roomMap.has('name'),
      hostedHere,
    });
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
