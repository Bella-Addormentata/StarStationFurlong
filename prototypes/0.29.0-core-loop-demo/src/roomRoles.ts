/**
 * 🤝 Room roles — co-host designation (durability plan C1, request/grant form)
 *
 * The room-LEVEL generalization of the door-rights plumbing (#67 D1b): two
 * room-doc maps, rebinding per join at the T0 seam —
 *  - `coHostRequests` : pub → a member's plea to become co-host
 *  - `coHosts`        : pub → a standing, owner-granted, revocable designation
 *
 * Keys are IDENTITY PUBKEYS (base64url Ed25519), same as door grants — a
 * designation survives leave/rejoin and ties into contacts.
 *
 * WHAT A CO-HOST IS (v1 — designation only): a member the owner trusts to
 * help keep the room ALIVE. The record is the shared truth that later slices
 * consume: node-side retention + serving of the room doc while the owner is
 * away (durability C4), co-host addresses riding pass hints (C3), and
 * eventually signed authority chains (roomProof C6). Deliberately NOT an
 * owner-powers grant: co-hosts do NOT pass owner gates (docking, edit mode,
 * policy) — durability first, authority later, and only signed (D3/C6).
 *
 * Enforcement posture: dev-phase UI gating on writes, shape-checked reads —
 * identical to doorPolicy. The owner-check lives with the caller (main.ts).
 */

import * as Y from 'yjs';

export interface CoHostRequest {
  pub: string;
  name: string;
  at: number;
}

export interface CoHostGrant {
  pub: string;
  name: string;
  grantedAt: number;
}

let boundDoc: Y.Doc | null = null;
let requestsMap: Y.Map<unknown> | null = null;
let coHostsMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[roomRoles] listener threw:', e); }
  }
}

export function bindRoomRoles(doc: Y.Doc): void {
  boundDoc = doc;
  requestsMap = doc.getMap('coHostRequests');
  coHostsMap = doc.getMap('coHosts');
  requestsMap.observe(() => notify());
  coHostsMap.observe(() => notify());
  notify();
}

export function subscribeRoomRoles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && coHostsMap !== null;
}

function isRequest(v: unknown): v is CoHostRequest {
  const r = v as Partial<CoHostRequest> | null;
  return !!r && typeof r.pub === 'string' && !!r.pub && typeof r.name === 'string' && typeof r.at === 'number';
}

function isGrant(v: unknown): v is CoHostGrant {
  const g = v as Partial<CoHostGrant> | null;
  return !!g && typeof g.pub === 'string' && !!g.pub && typeof g.name === 'string' && typeof g.grantedAt === 'number';
}

/** A member volunteers (their own client writes it). */
export function writeCoHostRequest(pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  boundDoc!.transact(() => {
    requestsMap!.set(pub, { pub, name: name || 'Unknown-Clone', at: Date.now() } satisfies CoHostRequest);
  });
}

/** Owner DENY (or a member withdrawing their own plea). */
export function removeCoHostRequest(pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { requestsMap!.delete(pub); });
}

export function readCoHostRequests(): CoHostRequest[] {
  if (!docAlive()) return [];
  const out: CoHostRequest[] = [];
  for (const v of requestsMap!.values()) if (isRequest(v)) out.push(v);
  return out.sort((a, b) => b.at - a.at);
}

export function hasCoHostRequest(pub: string): boolean {
  return docAlive() ? isRequest(requestsMap!.get(pub)) : false;
}

/** Owner ACCEPT: standing designation; consumes the request atomically. */
export function writeCoHost(pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  boundDoc!.transact(() => {
    coHostsMap!.set(pub, { pub, name: name || 'Unknown-Clone', grantedAt: Date.now() } satisfies CoHostGrant);
    requestsMap!.delete(pub);
  });
}

/** Owner REVOKE. */
export function removeCoHost(pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { coHostsMap!.delete(pub); });
}

export function readCoHosts(): CoHostGrant[] {
  if (!docAlive()) return [];
  const out: CoHostGrant[] = [];
  for (const v of coHostsMap!.values()) if (isGrant(v)) out.push(v);
  return out.sort((a, b) => b.grantedAt - a.grantedAt);
}

export function isCoHost(pub: string): boolean {
  return docAlive() ? isGrant(coHostsMap!.get(pub)) : false;
}
