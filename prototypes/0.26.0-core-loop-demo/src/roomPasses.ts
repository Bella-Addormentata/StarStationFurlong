/**
 * 🚪 Room passes list + background prefetch (issue #60 P2 — staged room-list UX)
 *
 * The ACCESS app keeps a persisted LIST of rooms the user holds a pass to.
 * Instead of beaming you the instant you paste a pass (the v0.26.0 behaviour,
 * which dropped you into a room mid-connect), USE PASS now just ADDS the room
 * to this list and starts loading it in the BACKGROUND — you stay where you
 * are, a per-room loading indicator runs (the vestibule-loading spirit), and
 * once the room's state has actually synced you tap it to enter instantly.
 *
 * How the background load works — the node already supports many rooms, and it
 * never drops one, so "warming" a room on the node makes a later join instant:
 *   - each pending pass gets its OWN NetworkProvider (a second WebTransport
 *     connection to the LOCAL node — the node keys rooms per connection, so a
 *     second channel on the ACTIVE connection would be misattributed) plus a
 *     passive YjsSync bound to that room's doc;
 *   - the prefetch bootstrap carries the host's memberHints, so the node dials
 *     the host and the room's state streams in;
 *   - "ready" = the node answered AND the host's roomInfo (name/owner) has
 *     arrived — i.e. the room is genuinely downloaded, not just "my node
 *     acknowledged". Until then the row shows LOADING.
 * Entering a ready room reuses performRoomSwap (fast — the node is warm and no
 * re-dial fires). A DEV "jump now" button keeps the immediate-transport path.
 *
 * The list is LOCAL (per-install, localStorage) — it is your set of keys, not
 * shared room truth. The raw seed is stored so a reload can re-warm every room
 * with full reachability (memberHints live only in the seed / active session).
 */

import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import type { RoomBootstrap } from './network/protocol';

export type PassState = 'connecting' | 'loading' | 'ready' | 'offline' | 'current';

/** Persisted pass — the raw seed is the full reconnect payload (memberHints
 *  included); roomId/name are decoded/synced copies for display + dedup. */
export interface RoomPass {
  seed: string;
  roomId: string;
  name: string;
  addedAt: number;
}

interface Prefetch {
  provider: NetworkProvider;
  sync: YjsSync | null;
  state: PassState;
  /** Bumped on every (re)start so a stale async resolve can't touch a newer
   *  prefetch of the same room (teardown/restart races). */
  epoch: number;
}

export interface RoomPassDeps {
  /** Decode a pasted pass / link into a RoomBootstrap (null if unreadable). */
  decode: (seed: string) => RoomBootstrap | null;
  /** Rewrite an imported bootstrap onto the LOCAL node (wtUrl + cert) while
   *  keeping the room key + host memberHints — resolveBridgeBootstrap. */
  resolve: (boot: RoomBootstrap) => Promise<RoomBootstrap>;
}

const STORAGE_KEY = 'ssf-room-passes';
const READY_TICK_MS = 250; // roomInfo poll cadence while a prefetch loads
const LOAD_TIMEOUT_MS = 25_000; // loading → offline if the host never delivers state

let deps: RoomPassDeps | null = null;
let passes: RoomPass[] = [];
const prefetches = new Map<string, Prefetch>();
const listeners = new Set<() => void>();
let activeRoomId: string | null = null;

// ── Persistence ──────────────────────────────────────────────────────────────

function load(): RoomPass[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is RoomPass =>
        p && typeof p.seed === 'string' && typeof p.roomId === 'string' && typeof p.name === 'string',
    );
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(passes));
  } catch {
    /* storage full / disabled — the list degrades to session-only */
  }
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (e) {
      console.error('[passes] listener threw:', e);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Wire the bootstrap helpers + restore the saved list, then start warming
 *  every pass (except the active room). Call once after networking is up. */
export function initRoomPasses(d: RoomPassDeps): void {
  deps = d;
  passes = load();
  notify();
  for (const p of passes) startPrefetch(p);
}

export function listPasses(): RoomPass[] {
  return passes.slice();
}

export function passState(roomId: string): PassState {
  if (roomId === activeRoomId) return 'current';
  return prefetches.get(roomId)?.state ?? 'connecting';
}

export function subscribePasses(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mark which room the local player is currently IN. Its pass (if any) shows
 *  CURRENT and its prefetch is torn down (the active session owns it); the
 *  room we just LEFT re-warms so the list stays live. */
export function setActivePassRoom(roomId: string | null): void {
  if (activeRoomId === roomId) return;
  const previous = activeRoomId;
  activeRoomId = roomId;
  // Stop warming the room we just entered — the active session owns it now.
  if (roomId) stopPrefetch(roomId);
  // Re-warm the room we just left, if it's a saved pass.
  if (previous) {
    const p = passes.find((x) => x.roomId === previous);
    if (p) startPrefetch(p);
  }
  // Retry any pass that went OFFLINE (node/host was down when it last tried) —
  // a room change is a cheap, natural moment to self-heal (review LOW), and
  // the node now reclaims the stale connection so re-warming doesn't leak.
  for (const p of passes) {
    if (p.roomId !== activeRoomId && prefetches.get(p.roomId)?.state === 'offline') {
      startPrefetch(p);
    }
  }
  notify();
}

/**
 * Add a pass to the list (dedup by roomId) and begin warming it. Returns the
 * decoded roomId, or an error string. Does NOT enter the room — the caller
 * renders the list; the user enters a room once it reads READY.
 */
export function addPass(seed: string): { ok: true; roomId: string } | { ok: false; error: string } {
  if (!deps) return { ok: false, error: 'passes not initialised' };
  const boot = deps.decode(seed.trim());
  if (!boot) return { ok: false, error: 'Invalid pass — paste a room link or seed.' };
  const roomId = boot.roomId;
  const existing = passes.find((p) => p.roomId === roomId);
  if (existing) {
    // Refresh the seed (newer hints) and re-warm rather than duplicate.
    existing.seed = seed.trim();
    persist();
    if (roomId !== activeRoomId) startPrefetch(existing);
    notify();
    return { ok: true, roomId };
  }
  const pass: RoomPass = { seed: seed.trim(), roomId, name: roomId, addedAt: Date.now() };
  passes.push(pass);
  persist();
  startPrefetch(pass);
  notify();
  return { ok: true, roomId };
}

export function removePass(roomId: string): void {
  stopPrefetch(roomId);
  passes = passes.filter((p) => p.roomId !== roomId);
  persist();
  notify();
}

/** The stored seed for a room (for entering / dev-jump via performRoomSwap). */
export function passSeed(roomId: string): string | null {
  return passes.find((p) => p.roomId === roomId)?.seed ?? null;
}

// ── Prefetch lifecycle ───────────────────────────────────────────────────────

function setState(roomId: string, state: PassState): void {
  const pf = prefetches.get(roomId);
  if (pf && pf.state !== state) {
    pf.state = state;
    notify();
  }
}

function stopPrefetch(roomId: string): void {
  const pf = prefetches.get(roomId);
  if (!pf) return;
  prefetches.delete(roomId);
  // Fire-and-forget teardown; the epoch bump already fenced its async resolves.
  void (async () => {
    try { await pf.sync?.stop(); } catch { /* doc may be gone */ }
    try { await pf.provider.disconnect(); } catch { /* transport may be gone */ }
  })();
}

function startPrefetch(pass: RoomPass): void {
  if (!deps) return;
  if (pass.roomId === activeRoomId) return; // active session owns it
  // Replace any existing prefetch for this room (re-warm with the latest seed).
  const prior = prefetches.get(pass.roomId);
  const epoch = (prior?.epoch ?? 0) + 1;
  if (prior) stopPrefetch(pass.roomId);

  const provider = new NetworkProvider();
  const pf: Prefetch = { provider, sync: null, state: 'connecting', epoch };
  prefetches.set(pass.roomId, pf);
  notify();

  void warm(pass, pf).catch((e) => {
    if (prefetches.get(pass.roomId) === pf) setState(pass.roomId, 'offline');
    console.warn(`[passes] prefetch for ${pass.roomId} failed:`, e);
  });
}

async function warm(pass: RoomPass, pf: Prefetch): Promise<void> {
  const d = deps!;
  const alive = () => prefetches.get(pass.roomId) === pf;

  const decoded = d.decode(pass.seed);
  if (!decoded) { if (alive()) setState(pass.roomId, 'offline'); return; }
  const boot = await d.resolve(decoded);
  if (!alive()) return;

  await pf.provider.connect(boot); // throws → caught by caller → 'offline'
  if (!alive()) { void pf.provider.disconnect(); return; }

  const channel = await pf.provider.openChannel('ysync');
  if (!alive()) { try { await channel.writable.close(); } catch {} return; }

  const sync = new YjsSync({
    roomId: boot.roomId,
    channel,
    // Stamp THIS room's dial hints on outgoing envelopes (review HIGH): without
    // this the prefetch inherits the ACTIVE room's hints from the global
    // provider and the node dials the wrong peer — the prefetch never syncs.
    bootRecord: () => pf.provider.getBootRecord(),
  });
  pf.sync = sync;
  // The node forwards this room's updates to THIS connection; feed them in.
  pf.provider.onEnvelope((env: { kind?: string; room?: string; payload?: string }) => {
    if (env.kind === 'ysync') sync.ingestEnvelope(env);
  });
  await sync.start();
  if (!alive()) return;
  setState(pass.roomId, 'loading');

  const roomMap = sync.doc.getMap('roomInfo');
  const ready = () => typeof roomMap.get('name') === 'string' && roomMap.has('owner');
  const finishReady = () => {
    if (!alive()) return;
    const name = roomMap.get('name');
    if (typeof name === 'string' && name) {
      const p = passes.find((x) => x.roomId === pass.roomId);
      if (p && p.name !== name) { p.name = name; persist(); }
    }
    setState(pass.roomId, 'ready');
  };
  // "Downloaded" = the host's roomInfo (name+owner) has arrived via the mesh —
  // poll for it directly (roomInfo fills as updates apply, independent of the
  // whenServerSynced signal, so we never block on a node that never answers).
  // After LOAD_TIMEOUT_MS still-not-ready surfaces OFFLINE so a dead room is
  // distinguishable from a slow one (review LOW); the poll keeps running, so a
  // late-arriving host still flips the row to READY.
  if (ready()) { finishReady(); return; }
  const deadline = performance.now() + LOAD_TIMEOUT_MS;
  const tick = () => {
    if (!alive()) return;
    if (ready()) { finishReady(); return; }
    if (performance.now() >= deadline && prefetches.get(pass.roomId)?.state === 'loading') {
      setState(pass.roomId, 'offline');
    }
    window.setTimeout(tick, READY_TICK_MS);
  };
  window.setTimeout(tick, READY_TICK_MS);
}
