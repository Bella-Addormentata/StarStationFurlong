/**
 * 🚏🤖📡 A room session held open — a background session to ANOTHER room's
 * doc that stays up while its holder works on that room (robot pilot routes,
 * open choice 8: a station docks a ferry with nobody aboard).
 *
 * farDoorWrite.ts and departuresWrite.ts each open a session for ONE write
 * and hang up. A station's gate keeper (gateKeeper.ts) needs a little more:
 * it reads a ferry's route, checkpoints and doors once a second for a minute
 * or two around each arrival and departure, and writes the ferry's side of a
 * dock, a cast-off or a checkpoint when the timetable says so. So this opens
 * the same session (its own NetworkProvider + YjsSync on the local node) and
 * hands it over instead of closing it.
 *
 * Opening waits for REAL room state exactly as a far write does
 * (farDoorWrite.roomStateArrived: a room hosted on this machine's node may
 * answer from its replica, one hosted elsewhere only through a fresh answer
 * from its live host), so nothing is decided on an empty or stale replica.
 * The whole open is bounded; a session that comes too late is hung up, never
 * handed over. Each write's acknowledgment is the node's
 * (YjsSync.confirmOwnWrites). Never throws.
 */

import type * as Y from 'yjs';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import type { RoomBootstrap } from './network/protocol';
import { ysyncSigner } from './keypair';
import { roomStateArrived, withTimeout } from './farDoorWrite';

/** The same seams the far writes are given (main.ts wires them alike). */
export interface RoomSessionDeps {
  /** Decode a pass / link into a bootstrap (null if unreadable). */
  decode: (seed: string) => RoomBootstrap | null;
  /** Rewrite it onto the LOCAL node, keeping the room key + host hints. */
  resolve: (boot: RoomBootstrap) => Promise<RoomBootstrap>;
  /** Is this room hosted by THIS machine's node? */
  hostedHere: (roomId: string) => boolean;
}

/** An open session to one room. */
export interface RoomSession {
  readonly roomId: string;
  /** The room's replica, kept in sync while the session is open. */
  readonly doc: Y.Doc;
  /** Has the node acknowledged every write made to `doc` since `since` (a
   *  state vector taken before them)? False once closed. */
  confirm(since: Uint8Array, timeoutMs: number): Promise<boolean>;
  /** Hang up (once; later calls do nothing). */
  close(): void;
  readonly closed: boolean;
}

/** How long the dial and the channel may each take. */
const DIAL_TIMEOUT_MS = 10_000;
/** How long the room's state may take to arrive (dial + sync). */
const READY_TIMEOUT_MS = 10_000;
/** …for a room hosted elsewhere, whose live host must answer. */
const HOST_READY_TIMEOUT_MS = 20_000;
/** The longest an open may take, end to end. */
const OPEN_DEADLINE_MS = 45_000;

/**
 * Open a session to the room `address` names (a pass or link for it), or
 * null when it cannot be read, reached or synced in time.
 */
export function openRoomSession(deps: RoomSessionDeps, address: string): Promise<RoomSession | null> {
  let imported: RoomBootstrap | null = null;
  try {
    imported = deps.decode(address);
  } catch {
    imported = null;
  }
  if (!imported) return Promise.resolve(null);
  const boot0 = imported;
  let provider: NetworkProvider | null = null;
  let sync: YjsSync | null = null;
  let closed = false;
  /** Past the deadline: whatever the open reaches later is hung up. */
  let late = false;
  const hangUp = (): void => {
    if (closed) return;
    closed = true;
    // Both at once, never awaited: a transport that wedges on close must not
    // keep anyone waiting (farDoorWrite's session hangs up the same way).
    const closing = { sync, provider };
    void closing.sync?.stop().catch(() => undefined);
    void closing.provider?.disconnect().catch(() => undefined);
  };

  const open = async (): Promise<RoomSession | null> => {
    const boot = await deps.resolve(boot0);
    if (late) return null;
    provider = new NetworkProvider();
    const p = provider;
    await withTimeout(p.connect(boot), DIAL_TIMEOUT_MS, 'room session dial');
    const channel = await withTimeout(p.openChannel('ysync'), DIAL_TIMEOUT_MS, 'room session channel');
    if (late) return null;
    sync = new YjsSync({
      roomId: boot.roomId,
      channel,
      ...ysyncSigner(),
      // THIS room's dial hints on our envelopes, never the active room's.
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
    if (late) return null;
    const hostedHere = deps.hostedHere(boot.roomId);
    // A room hosted elsewhere is known only from its live host (see
    // farDoorWrite's session for why the gate is armed at once).
    if (!hostedHere) s.markPeerLinked();
    const within = hostedHere ? READY_TIMEOUT_MS : HOST_READY_TIMEOUT_MS;
    if (!(await roomStateArrived(s, within, hostedHere))) {
      console.warn(`[roomSession] ${boot.roomId}: no ${hostedHere ? 'room state' : 'answer from its host'} within ${within} ms`);
      return null;
    }
    if (late) return null;
    return {
      roomId: boot.roomId,
      doc: s.doc,
      confirm: (since, timeoutMs) =>
        (closed ? Promise.resolve(false) : s.confirmOwnWrites(since, timeoutMs).catch(() => false)),
      close: hangUp,
      get closed() {
        return closed;
      },
    };
  };

  return new Promise<RoomSession | null>((resolve) => {
    let done = false;
    const finish = (session: RoomSession | null): void => {
      if (done) {
        session?.close();
        return;
      }
      done = true;
      clearTimeout(timer);
      if (!session) hangUp();
      resolve(session);
    };
    const timer = setTimeout(() => {
      late = true;
      console.warn(`[roomSession] ${boot0.roomId}: not open within ${OPEN_DEADLINE_MS} ms — abandoned`);
      finish(null);
    }, OPEN_DEADLINE_MS);
    open().then(finish, (err) => {
      console.warn('[roomSession] session failed:', err);
      finish(null);
    });
  });
}
