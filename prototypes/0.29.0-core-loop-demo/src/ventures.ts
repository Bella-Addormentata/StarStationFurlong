/**
 * 🚀 Ventures — joint ownership of rooms (issue #68, V1 game-first slice)
 *
 * A VENTURE is a jointly-owned entity: founded by signing a CHARTER in a room
 * you own (that room becomes the venture's REGISTERED OFFICE and its first
 * property), issuing a fixed 100 SHARES to the founder. Shares move between
 * players; the OWNER RULE (v1, owner's ruling): holding ANY share grants full
 * owner-equivalent access to venture property — main.ts folds shareholding
 * into the central owner gate, so every owner-gated surface (docking, edit
 * mode, policies, co-hosts) opens to shareholders with one seam.
 *
 * V1 SCOPE — one room per venture (the office). Multi-room property arrives
 * with the signed authority-stamp pattern (chia-authority-architecture.md
 * phase 2); the Registry anchor (Charter = share issuance on Chia, deeds
 * custodied by the venture) is #68 V3 and changes NOTHING about this UX.
 *
 * PLAIN-LANGUAGE RULE (#68, hard requirement): everything here speaks in
 * deeds / charters / shares / ventures. No chain jargon anywhere.
 *
 * Storage: the venture record lives in the OFFICE room's doc (`venture` map,
 * T0 rebind like every shared map); a small personal ledger (localStorage)
 * remembers which ventures YOU hold shares in so the VENTURES app can list
 * them from anywhere.
 */

import * as Y from 'yjs';

export const CHARTER_TOTAL_SHARES = 100;

/** The room-doc record — one venture per room in V1 (`venture` map, key 'v'). */
export interface VentureRecord {
  id: string;            // stable venture id (random, minted at founding)
  name: string;
  foundedAt: number;
  founderPub: string;    // identity pubkey (base64url Ed25519)
  founderName: string;
  totalShares: number;   // fixed at CHARTER_TOTAL_SHARES in V1
  /** pub → share count. Sum ≤ totalShares (validated on read). */
  shares: Record<string, number>;
  /** pub → display name (denormalized for the cap table). */
  holderNames: Record<string, string>;
}

/** Personal ledger entry (localStorage) — powers the app's list screen. */
export interface VentureLedgerEntry {
  id: string;
  name: string;
  officeRoomId: string;
  myShares: number;
  totalShares: number;
  lastSeenAt: number;
}

const LEDGER_KEY = 'ssf-venture-ledger';

let boundDoc: Y.Doc | null = null;
let ventureMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[ventures] listener threw:', e); }
  }
}

export function bindVentures(doc: Y.Doc): void {
  boundDoc = doc;
  ventureMap = doc.getMap('venture');
  ventureMap.observe(() => notify());
  notify();
}

export function subscribeVentures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && ventureMap !== null;
}

/** Shape-checked read of the CURRENT room's venture (null when none/invalid).
 *  Share counts are clamped to non-negative integers and the total is
 *  validated — a malformed peer write degrades to "no venture", never NaN
 *  authority. */
export function ventureRecord(): VentureRecord | null {
  if (!docAlive()) return null;
  const raw = ventureMap!.get('v') as Partial<VentureRecord> | undefined;
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string'
    || typeof raw.founderPub !== 'string' || !raw.founderPub
    || typeof raw.totalShares !== 'number' || !Number.isFinite(raw.totalShares)
    || typeof raw.shares !== 'object' || raw.shares === null) return null;
  const shares: Record<string, number> = {};
  let sum = 0;
  for (const [pub, n] of Object.entries(raw.shares)) {
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
    if (count > 0 && typeof pub === 'string' && pub) { shares[pub] = count; sum += count; }
  }
  if (sum > raw.totalShares) return null; // over-issued record = invalid
  const holderNames: Record<string, string> = {};
  if (typeof raw.holderNames === 'object' && raw.holderNames !== null) {
    for (const [pub, name] of Object.entries(raw.holderNames)) {
      if (typeof name === 'string') holderNames[pub] = name;
    }
  }
  return {
    id: raw.id,
    name: raw.name || 'Unnamed Venture',
    foundedAt: typeof raw.foundedAt === 'number' ? raw.foundedAt : 0,
    founderPub: raw.founderPub,
    founderName: typeof raw.founderName === 'string' ? raw.founderName : 'Unknown-Clone',
    totalShares: Math.floor(raw.totalShares),
    shares,
    holderNames,
  };
}

/** ANY share ⇒ owner-equivalent access (v1 owner rule). */
export function isVentureShareholder(pub: string): boolean {
  const v = ventureRecord();
  return !!v && (v.shares[pub] ?? 0) > 0;
}

export function myVentureShares(pub: string): number {
  return ventureRecord()?.shares[pub] ?? 0;
}

/** Sign the Charter: found a venture in the CURRENT room (caller enforces
 *  "you own this room" + "no venture here yet"). All 100 shares → founder. */
export function foundVenture(name: string, founderPub: string, founderName: string): boolean {
  if (!docAlive() || !founderPub || ventureRecord() !== null) return false;
  const clean = name.trim().slice(0, 48);
  if (!clean) return false;
  const id = `vnt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  boundDoc!.transact(() => {
    ventureMap!.set('v', {
      id,
      name: clean,
      foundedAt: Date.now(),
      founderPub,
      founderName: founderName || 'Unknown-Clone',
      totalShares: CHARTER_TOTAL_SHARES,
      shares: { [founderPub]: CHARTER_TOTAL_SHARES },
      holderNames: { [founderPub]: founderName || 'Unknown-Clone' },
    } satisfies VentureRecord);
  });
  return true;
}

/**
 * Transfer shares YOU hold to another player (self-authorized — you may only
 * move your own stake; the UI passes your own pub as `fromPub`). Whole-record
 * rewrite inside one transact (last-writer-wins on races — acceptable at V1
 * scale; the Registry anchor replaces this arithmetic wholesale in V3).
 */
export function transferShares(fromPub: string, toPub: string, toName: string, count: number): boolean {
  if (!docAlive() || !fromPub || !toPub || fromPub === toPub) return false;
  const v = ventureRecord();
  if (!v) return false;
  const n = Math.floor(count);
  const held = v.shares[fromPub] ?? 0;
  if (n <= 0 || n > held) return false;
  const shares = { ...v.shares, [fromPub]: held - n, [toPub]: (v.shares[toPub] ?? 0) + n };
  if (shares[fromPub] === 0) delete shares[fromPub];
  const holderNames = { ...v.holderNames, [toPub]: toName || 'Unknown-Clone' };
  boundDoc!.transact(() => {
    ventureMap!.set('v', { ...v, shares, holderNames });
  });
  return true;
}

// ── Personal ledger (the app's list screen) ──────────────────────────────────

export function ventureLedger(): VentureLedgerEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is VentureLedgerEntry =>
      !!e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.officeRoomId === 'string');
  } catch { return []; }
}

/** Called on every bind/observe when the current room holds a venture we're
 *  in (or dropped out of) — keeps the list screen current. */
export function upsertVentureLedger(entry: VentureLedgerEntry): void {
  try {
    const rest = ventureLedger().filter((e) => e.id !== entry.id);
    localStorage.setItem(LEDGER_KEY, JSON.stringify([entry, ...rest].slice(0, 50)));
  } catch { /* privacy mode — list screen degrades to current room only */ }
}

export function removeFromVentureLedger(id: string): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ventureLedger().filter((e) => e.id !== id)));
  } catch { /* ignore */ }
}
