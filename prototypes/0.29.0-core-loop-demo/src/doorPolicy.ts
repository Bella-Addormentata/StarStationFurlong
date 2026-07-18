/**
 * 🚦 Per-door permissions + rights requests (#67 D1/D1b)
 *
 * Three shared maps in the room doc (rebind per join, T0 seam, exactly the
 * doorsDoc pattern):
 *  - `doorPolicy`   : door id → { passage, construction } — the owner's rules.
 *  - `doorRequests` : `${doorId}|${pub}` → a player's plea for build rights.
 *  - `doorGrants`   : `${doorId}|${pub}` → a standing, revocable grant.
 *
 * MODES. passage: 'public' (default — today's behavior, anyone opens/closes/
 * walks) | 'owner'. construction: 'owner' (default — the v0.30.7 gate) |
 * 'request' (anyone may ASK; owner approves into a grant) | 'public'.
 *
 * Grants are keyed to IDENTITY PUBKEYS (base64url Ed25519, keypair.ts), not
 * ephemeral player ids — a grant survives leave/rejoin and ties into the
 * contacts system. This is the game's first owner-mediated social contract;
 * the same plumbing generalizes to co-host designation (durability C1) later.
 *
 * POLICY LIVES HERE, NOT ON DoorRecord: pairing records are deleted on unpair
 * (the one-way-vestibule investigation's lesson) — policy must survive that.
 *
 * Enforcement posture (dev phase, same as edit mode / the docking owner gate):
 * WRITE-side is UI-gated (owner-only controls), READ-side is shape-validated
 * but not cryptographically verified — signed records are #67 D3.
 */

import * as Y from 'yjs';

export type PassageMode = 'public' | 'owner';
export type ConstructionMode = 'owner' | 'request' | 'public';

export interface DoorPolicyRecord {
  passage: PassageMode;
  construction: ConstructionMode;
  /** #67 D2: a 🔌 Docking Adapter is INSTALLED at this door — anyone may
   *  TRANSIENTLY berth a ship module here (no chains, no station-graph
   *  permanence, either side detaches). Owner installs/removes (consumes/
   *  refunds an ADAPTER part). */
  adapter?: boolean;
}

export interface DoorRightsRequest {
  doorId: string;
  requesterPub: string;   // base64url Ed25519 identity key
  requesterName: string;
  at: number;
}

export interface DoorRightsGrant {
  doorId: string;
  pub: string;
  name: string;
  grantedAt: number;
}

export const DEFAULT_DOOR_POLICY: DoorPolicyRecord = { passage: 'public', construction: 'owner' };

const DOOR_IDS = ['north', 'south', 'east', 'west'] as const;

let boundDoc: Y.Doc | null = null;
let policyMap: Y.Map<unknown> | null = null;
let requestsMap: Y.Map<unknown> | null = null;
let grantsMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[doorPolicy] listener threw:', e); }
  }
}

export function bindDoorPolicy(doc: Y.Doc): void {
  boundDoc = doc;
  policyMap = doc.getMap('doorPolicy');
  requestsMap = doc.getMap('doorRequests');
  grantsMap = doc.getMap('doorGrants');
  policyMap.observe(() => notify());
  requestsMap.observe(() => notify());
  grantsMap.observe(() => notify());
  notify();
}

export function subscribeDoorPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && policyMap !== null;
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** Sanitized read; unknown/missing values fall back to the defaults. */
export function readDoorPolicy(doorId: string): DoorPolicyRecord {
  if (!docAlive() || !(DOOR_IDS as readonly string[]).includes(doorId)) return { ...DEFAULT_DOOR_POLICY };
  const raw = policyMap!.get(doorId) as Partial<DoorPolicyRecord> | undefined;
  return {
    passage: raw?.passage === 'owner' ? 'owner' : 'public',
    construction: raw?.construction === 'request' || raw?.construction === 'public' ? raw.construction : 'owner',
    adapter: raw?.adapter === true,
  };
}

/** Owner UI only (write-side gating is the caller's job — see module header). */
export function writeDoorPolicy(doorId: string, policy: DoorPolicyRecord): void {
  if (!docAlive() || !(DOOR_IDS as readonly string[]).includes(doorId)) return;
  boundDoc!.transact(() => {
    policyMap!.set(doorId, {
      passage: policy.passage,
      construction: policy.construction,
      adapter: policy.adapter === true,
    });
  });
}

// ── Requests ─────────────────────────────────────────────────────────────────

function reqKey(doorId: string, pub: string): string {
  return `${doorId}|${pub}`;
}

function isRequest(v: unknown): v is DoorRightsRequest {
  const r = v as Partial<DoorRightsRequest> | null;
  return !!r && typeof r.doorId === 'string' && typeof r.requesterPub === 'string'
    && !!r.requesterPub && typeof r.requesterName === 'string' && typeof r.at === 'number';
}

/** A player asks for build rights at a door (their own client writes it). */
export function writeDoorRequest(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  boundDoc!.transact(() => {
    requestsMap!.set(reqKey(doorId, pub), {
      doorId, requesterPub: pub, requesterName: name || 'Unknown-Clone', at: Date.now(),
    } satisfies DoorRightsRequest);
  });
}

export function removeDoorRequest(doorId: string, pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { requestsMap!.delete(reqKey(doorId, pub)); });
}

/** All pending requests, optionally for one door (sanitized, newest first). */
export function readDoorRequests(doorId?: string): DoorRightsRequest[] {
  if (!docAlive()) return [];
  const out: DoorRightsRequest[] = [];
  for (const v of requestsMap!.values()) {
    if (isRequest(v) && (!doorId || v.doorId === doorId)) out.push(v);
  }
  return out.sort((a, b) => b.at - a.at);
}

export function hasDoorRequest(doorId: string, pub: string): boolean {
  return docAlive() ? isRequest(requestsMap!.get(reqKey(doorId, pub))) : false;
}

// ── Grants ───────────────────────────────────────────────────────────────────

function isGrant(v: unknown): v is DoorRightsGrant {
  const g = v as Partial<DoorRightsGrant> | null;
  return !!g && typeof g.doorId === 'string' && typeof g.pub === 'string' && !!g.pub
    && typeof g.name === 'string' && typeof g.grantedAt === 'number';
}

/** Owner ACCEPT: standing, revocable grant; clears the matching request. */
export function writeDoorGrant(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  boundDoc!.transact(() => {
    grantsMap!.set(reqKey(doorId, pub), {
      doorId, pub, name: name || 'Unknown-Clone', grantedAt: Date.now(),
    } satisfies DoorRightsGrant);
    requestsMap!.delete(reqKey(doorId, pub));
  });
}

/** Owner REVOKE (or DENY doubles as remove-request via removeDoorRequest). */
export function removeDoorGrant(doorId: string, pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { grantsMap!.delete(reqKey(doorId, pub)); });
}

export function readDoorGrants(doorId?: string): DoorRightsGrant[] {
  if (!docAlive()) return [];
  const out: DoorRightsGrant[] = [];
  for (const v of grantsMap!.values()) {
    if (isGrant(v) && (!doorId || v.doorId === doorId)) out.push(v);
  }
  return out.sort((a, b) => b.grantedAt - a.grantedAt);
}

export function hasDoorGrant(doorId: string, pub: string): boolean {
  return docAlive() ? isGrant(grantsMap!.get(reqKey(doorId, pub))) : false;
}
