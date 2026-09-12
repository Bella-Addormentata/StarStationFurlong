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

/** The room-doc record (`venture` map, key 'v').
 *
 *  V2 — two flavors, same shape:
 *  - OFFICE record (the founding room): THE authoritative cap table. No
 *    `snapshotAt`. Transfers happen only here.
 *  - PROPERTY LINK (any other module assigned to the venture): a SNAPSHOT of
 *    the office cap table, stamped `snapshotAt`, refreshed by VISITATION
 *    GOSSIP — any shareholder whose personal ledger carries a NEWER cap
 *    table (they visited the office since) rewrites the link on entry. No
 *    cross-doc sync exists (one doc at a time), so freshness spreads the way
 *    people do; the V3 Registry anchor replaces this wholesale. */
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
  /** The venture's registered-office room id (absent on pre-V2 records). */
  officeRoomId?: string;
  /** PROPERTY LINK marker: when this record was snapshotted from the ledger.
   *  Absent ⇒ this room IS the office (authoritative). */
  snapshotAt?: number;
}

/** Personal ledger entry (localStorage) — powers the app's list screen AND
 *  carries the freshest cap table this player has SEEN (visitation gossip). */
export interface VentureLedgerEntry {
  id: string;
  name: string;
  officeRoomId: string;
  myShares: number;
  totalShares: number;
  lastSeenAt: number;
  /** Freshest cap table seen + when (source: office visits or newer links). */
  shares?: Record<string, number>;
  holderNames?: Record<string, string>;
  capSeenAt?: number;
  /** Property modules seen for this venture (room ids, capped). */
  properties?: string[];
}

const LEDGER_KEY = 'ssf-venture-ledger';

/** 🕒 How far ahead of OUR clock a peer's `snapshotAt` may sit before the record
 *  is refused (#143). The comparison is against the reader's own clock and a
 *  browser mesh has no NTP guarantee, so this must cover honest skew — but
 *  whatever slack it allows is exactly the head start an attacker keeps, hence
 *  hours rather than days. */
const MAX_SNAPSHOT_SKEW_MS = 6 * 60 * 60 * 1000;

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
  // founderPub may be EMPTY on V2 property links (display metadata only —
  // authority lives in the shares map); it must still be a string.
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string'
    || typeof raw.founderPub !== 'string'
    || typeof raw.totalShares !== 'number' || !Number.isFinite(raw.totalShares)
    || typeof raw.shares !== 'object' || raw.shares === null) return null;
  const shares: Record<string, number> = {};
  let sum = 0;
  for (const [pub, n] of Object.entries(raw.shares)) {
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
    if (count > 0 && typeof pub === 'string' && pub) { shares[pub] = count; sum += count; }
  }
  if (sum > raw.totalShares) return null; // over-issued record = invalid
  // 🕒 A property link's `snapshotAt` is PEER-WRITTEN and drives the monotonic
  // refresh rule below (refreshVentureLink only accepts a NEWER stamp). Left
  // unbounded, a planted far-future stamp pins the link — and the cap table it
  // carries — against every honest refresh forever, because no reachable
  // Date.now() can beat it. Same failure treasuryDoc's putPolicyCache comment
  // already names: "a local version-monotonicity rule over UNAUTHENTICATED
  // entries would let a planted max-version record brick the cache."
  // Reject the whole record rather than rewriting the stamp: this is the read
  // boundary AND the ingest point (a hostile peer writes the map directly,
  // bypassing writeVentureLink/refreshVentureLink), and a read-time rewrite
  // would be re-persisted by the next refresh's `{...v}` spread.
  const stamp = typeof raw.snapshotAt === 'number' && Number.isFinite(raw.snapshotAt)
    ? raw.snapshotAt
    : undefined;
  if (stamp !== undefined && stamp > Date.now() + MAX_SNAPSHOT_SKEW_MS) return null;
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
    officeRoomId: typeof raw.officeRoomId === 'string' ? raw.officeRoomId : undefined,
    snapshotAt: stamp,
  };
}

/** Is the CURRENT room this venture's registered office (authoritative cap
 *  table — transfers allowed)? Property links carry `snapshotAt`. */
export function isOfficeHere(): boolean {
  const v = ventureRecord();
  return !!v && v.snapshotAt === undefined;
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
export function foundVenture(name: string, founderPub: string, founderName: string, officeRoomId?: string): boolean {
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
      officeRoomId,
    } satisfies VentureRecord);
  });
  return true;
}

/** 🏠 V2: assign the CURRENT room to a venture as PROPERTY — writes a link
 *  record snapshotted from the caller's ledger knowledge (the freshest cap
 *  table they've seen). Caller enforces: room is personally owned by them,
 *  unchartered, and they hold shares. Refused when a venture already sits
 *  here (office or link). */
export function writeVentureLink(entry: VentureLedgerEntry): boolean {
  if (!docAlive() || ventureRecord() !== null) return false;
  if (!entry.shares || !entry.capSeenAt) return false; // no cap table seen yet
  boundDoc!.transact(() => {
    ventureMap!.set('v', {
      id: entry.id,
      name: entry.name,
      foundedAt: 0,
      founderPub: '',
      founderName: '',
      totalShares: entry.totalShares,
      shares: { ...entry.shares },
      holderNames: { ...(entry.holderNames ?? {}) },
      officeRoomId: entry.officeRoomId,
      snapshotAt: entry.capSeenAt,
    });
  });
  return true;
}

/** V2: refresh a STALE property link in place from newer ledger knowledge.
 *  No-op unless this room holds a link for the same venture with an older
 *  snapshot. Returns true when a refresh was written. */
export function refreshVentureLink(entry: VentureLedgerEntry): boolean {
  if (!docAlive() || !entry.shares || !entry.capSeenAt) return false;
  const v = ventureRecord();
  if (!v || v.snapshotAt === undefined || v.id !== entry.id) return false;
  if (v.snapshotAt >= entry.capSeenAt) return false;
  boundDoc!.transact(() => {
    ventureMap!.set('v', {
      ...v,
      totalShares: entry.totalShares,
      shares: { ...entry.shares },
      holderNames: { ...(entry.holderNames ?? {}) },
      snapshotAt: entry.capSeenAt,
    });
  });
  return true;
}

/** V2: detach the CURRENT room from its venture (property links only — the
 *  office cannot detach; caller gates to the room's PERSONAL owner). */
export function removeVentureLink(): boolean {
  if (!docAlive()) return false;
  const v = ventureRecord();
  if (!v || v.snapshotAt === undefined) return false;
  boundDoc!.transact(() => { ventureMap!.delete('v'); });
  return true;
}

/**
 * 🩹 #142 repair path: drop an OFFICE record (`snapshotAt === undefined`)
 * from the current room. `removeVentureLink` deliberately refuses these, so
 * before this existed a fabricated office record was **unremovable through
 * the UI** — additive, invisible to the real owner, and it froze the deed
 * permanently.
 *
 * ⚠️ DELIBERATELY UNGATED, and that is a trade, not an oversight.
 *
 * Nothing authorizes a write to a room doc today — a modified client writes
 * any Yjs record it likes — so an ownership gate here stops no attacker: the
 * one who planted the record just plants it again. What a gate *would* stop
 * is the victim cleaning up, which is the only thing the gate reliably
 * achieves. So the gate comes off.
 *
 * The cost, stated plainly: anyone standing in a venture's LEGITIMATE
 * registered office can now delete its registration, which was previously
 * impossible through the UI. That is a real new griefing vector, accepted
 * because the alternative leaves victims with no repair at all. It stops
 * being a trade at all once writes are authorized — at that point this
 * should take the same grant-set check as every other write, and the
 * ungated path should go away with it.
 */
export function detachOfficeRecord(): boolean {
  if (!docAlive()) return false;
  const v = ventureRecord();
  if (!v || v.snapshotAt !== undefined) return false; // links use removeVentureLink
  boundDoc!.transact(() => { ventureMap!.delete('v'); });
  // 🧹 The personal ledger is the OTHER half of the repair, and deleting only
  // the doc record left it behind. `syncVentureLedgerFromCurrentRoom` cannot
  // clean it up afterwards — its first line returns early once `ventureRecord()`
  // is null — so the fabricated venture stayed in the victim's VENTURES list,
  // still naming them a shareholder, and the stale entry still fed the
  // `ADD THIS MODULE` path, which would re-propagate the forged cap table into
  // a room they really do own. Deregistering has to mean both.
  //
  // This lives HERE rather than in the caller so it is covered by tests: the
  // ledger is exactly the kind of second-order state that a UI-side call site
  // forgets, and #143's own writeup already flagged `removeFromVentureLedger`
  // as having no callers — the repair path was identified and then not wired.
  removeFromVentureLedger(v.id);
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
  // V2: transfers happen at the OFFICE only — a property link's cap table is
  // a snapshot; writing trades into it would fork the truth.
  if (v.snapshotAt !== undefined) return false;
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
    return arr
      .filter((e): e is VentureLedgerEntry =>
        !!e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.officeRoomId === 'string')
      // 🕒 The stored `capSeenAt` came from a peer-written record and PERSISTS
      // across upgrades, so the record-level bound in ventureRecord cannot
      // reach a ledger that was already poisoned. Left alone it stays "fresher"
      // than every office visit (syncVentureLedgerFromCurrentRoom's
      // `ledgerFresher`), keeps the forged cap table, and gets handed back to
      // refreshVentureLink — which would write a stamp ventureRecord then
      // refuses, making the property record unreadable. Drop the impossible
      // stamp rather than the whole entry: the venture is real, only its
      // freshness claim is not, and a zeroed stamp loses to the next honest
      // office visit, which is exactly the self-heal we want.
      .map((e) => (typeof e.capSeenAt === 'number' && e.capSeenAt > Date.now() + MAX_SNAPSHOT_SKEW_MS
        ? { ...e, capSeenAt: 0 }
        : e));
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
