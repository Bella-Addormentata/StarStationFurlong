/**
 * 🚫 Client-side block list (issue #20 — contacts BLOCK)
 *
 * A LOCAL, personal mute. A blocked identity's messages don't render on YOUR
 * screen and they are hidden from YOUR CLONES SEEN roster. This is NOT server
 * enforcement: in the dev-phase P2P posture the blocked side still broadcasts,
 * their bytes still arrive over the transport, and the room doc still
 * replicates their entries. A signed on-doc block op (RoomLog `mod-flag` /
 * personal `block`) is the enforceable path — TrustAndSafety.md names that
 * home; it is NOT this slice. See §3.2 of brainstorming/phone-apps-breakdown.md
 * for the same design decision.
 *
 * Storage: localStorage under `ssf-blocked-pubs` — a JSON array of the
 * base64url Ed25519 identity public keys the local install has blocked. The
 * pub is the durable, cross-room stable id (getIdentityPub); the legacy
 * per-install player id (players map key) can be RESOLVED to a pub via the
 * players-map row (keyB64) so blocks match legacy messages too.
 *
 * Every mutation persists and fans out to subscribers so the phone can repaint
 * the roster + chat + contacts list synchronously with the block/unblock click.
 */

const STORAGE_KEY = 'ssf-blocked-pubs';

let blocked = new Set<string>();
const listeners = new Set<() => void>();
let initialized = false;

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const s = new Set<string>();
    for (const p of parsed) {
      // Guard: only well-shaped strings are accepted — a corrupted store must
      // not brick load (the block list is best-effort local state, not truth).
      if (typeof p === 'string' && p) s.add(p);
    }
    return s;
  } catch {
    return new Set();
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...blocked]));
  } catch {
    /* privacy-mode / quota — session-only fallback (like contacts.ts) */
  }
}

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[blockList] listener threw:', e); }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Load persisted blocks. Idempotent — safe to call from boot even if a test
 *  or a hot module reload has already loaded. */
export function initBlockList(): void {
  blocked = load();
  initialized = true;
  notify();
}

/** True iff the given base64url identity pub is on the local block list. */
export function isBlocked(pub: string): boolean {
  if (typeof pub !== 'string' || !pub) return false;
  return blocked.has(pub);
}

/** Copy of the blocked pubs (stable snapshot for renderers). */
export function listBlocked(): string[] {
  return [...blocked];
}

/** Read-only view for filter callers that just need `has(pub)` — avoids the
 *  copy each render. Never mutate through this handle (Set exposes .add but the
 *  API is deliberately named to make read-only intent obvious to reviewers). */
export function blockedSet(): ReadonlySet<string> {
  return blocked;
}

/** Toggle a pub's block state; persists + notifies on real change only (avoids
 *  spurious re-renders when the block is already in the requested state). */
export function setBlocked(pub: string, on: boolean): void {
  if (typeof pub !== 'string' || !pub) return;
  const has = blocked.has(pub);
  if (on === has) return;
  if (on) blocked.add(pub); else blocked.delete(pub);
  persist();
  notify();
}

/** Register a change listener; returns the unsubscribe fn. */
export function subscribeBlockList(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test-only reset — clears the in-memory set and localStorage so a fresh
 *  vitest can start from a known state. Never called from the app. */
export function __resetBlockListForTests(): void {
  blocked = new Set();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  initialized = false;
  // Deliberately DO NOT notify — tests set state themselves and check counts.
}

// ── Pure filter helpers (used by the UI wire-up and by vitest) ────────────────

/** A chat / DM / roster entry the block filter can score against. Both id
 *  spaces we accept:
 *   - `authorPub` — the canonical Ed25519 pub. Every keyed-identity write
 *     should carry this (new chat/group-chat messages will).
 *   - `authorId` — the legacy per-install UUID (players map key). Pre-slice
 *     chat messages carry only this; the resolver maps it → pub via the
 *     current players map so blocks match those too. */
export interface AuthoredEntry {
  authorPub?: unknown;
  authorId?: unknown;
}

/** Look up the identity pub for a legacy `authorId` (players map key). The
 *  caller supplies the mapping — engine module is decoupled from Yjs. */
export type PubResolver = (authorId: string) => string | undefined;

const NEVER = (): undefined => undefined;

/** True iff `entry` is authored by someone on the block set. Canonical
 *  `authorPub` is AUTHORITATIVE when present — a "not blocked" answer from
 *  the canonical id is trusted, and the resolver is NOT consulted (a peer
 *  could otherwise spoof a legacy `authorId` matching a blocked player and
 *  poison the filter). The resolver is only a fallback for pre-slice legacy
 *  messages that carry `authorId` only. */
export function isAuthoredByBlocked(
  entry: AuthoredEntry,
  blockedPubs: ReadonlySet<string>,
  resolver: PubResolver = NEVER,
): boolean {
  if (blockedPubs.size === 0) return false;
  if (typeof entry.authorPub === 'string' && entry.authorPub) {
    return blockedPubs.has(entry.authorPub);
  }
  if (typeof entry.authorId === 'string' && entry.authorId) {
    const pub = resolver(entry.authorId);
    if (typeof pub === 'string' && pub && blockedPubs.has(pub)) return true;
  }
  return false;
}

/** Drop entries authored by anyone on the block set. Pure — safe to test.
 *  Preserves relative order of the survivors. Zero-alloc fast path when the
 *  set is empty (returns a shallow copy so the caller can still mutate). */
export function filterOutBlocked<T extends AuthoredEntry>(
  entries: readonly T[],
  blockedPubs: ReadonlySet<string>,
  resolver: PubResolver = NEVER,
): T[] {
  if (blockedPubs.size === 0) return entries.slice();
  return entries.filter((e) => !isAuthoredByBlocked(e, blockedPubs, resolver));
}

/** Split a roster into (visible, blocked) partitions — used by the CLONES SEEN
 *  renderer so blocked players are hidden and a "N blocked" note can show. */
export function partitionRosterByBlocked<T extends { pub?: string }>(
  entries: readonly T[],
  blockedPubs: ReadonlySet<string>,
): { visible: T[]; blocked: T[] } {
  if (blockedPubs.size === 0) return { visible: entries.slice(), blocked: [] };
  const visible: T[] = [];
  const blockedRows: T[] = [];
  for (const e of entries) {
    if (typeof e.pub === 'string' && e.pub && blockedPubs.has(e.pub)) blockedRows.push(e);
    else visible.push(e);
  }
  return { visible, blocked: blockedRows };
}

/** Debug helper: whether initBlockList has run (set by init). Callers may
 *  ignore this — the app's own boot funnels through initBlockList. */
export function isBlockListInitialized(): boolean {
  return initialized;
}
