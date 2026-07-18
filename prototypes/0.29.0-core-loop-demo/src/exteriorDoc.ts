/**
 * ☀️ Exterior attachments sync (#65 exterior view)
 *
 * Items mounted OUTSIDE the module hull — v1: solar panels in four roof
 * slots. One room-doc Y.Map `exterior`, keyed by slot ('0'..'3'), records
 * `{ kind: 'solar' }`. Same discipline as furnitureDoc: rebind per join,
 * owner-gated writes (UI side), shape-checked reads, observers drive the
 * exterior-view rebuild. More kinds (antennas, dishes, radiators) later.
 */

import * as Y from 'yjs';

export type ExteriorKind = 'solar';
export const EXTERIOR_SLOTS = ['0', '1', '2', '3'] as const;

export interface ExteriorRecord {
  kind: ExteriorKind;
}

let boundDoc: Y.Doc | null = null;
let exteriorMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[exterior] listener threw:', e); }
  }
}

export function bindExteriorDoc(doc: Y.Doc): void {
  boundDoc = doc;
  exteriorMap = doc.getMap('exterior');
  exteriorMap.observe(() => notify());
  notify();
}

export function subscribeExterior(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && exteriorMap !== null;
}

function isRecord(v: unknown): v is ExteriorRecord {
  return !!v && typeof v === 'object' && (v as ExteriorRecord).kind === 'solar';
}

/** Snapshot slot → record (malformed entries skipped). */
export function readExterior(): Map<string, ExteriorRecord> {
  const out = new Map<string, ExteriorRecord>();
  if (!docAlive()) return out;
  for (const slot of EXTERIOR_SLOTS) {
    const v = exteriorMap!.get(slot);
    if (isRecord(v)) out.set(slot, v);
  }
  return out;
}

/** First empty roof slot, or null when full. */
export function nextFreeExteriorSlot(): string | null {
  const taken = readExterior();
  for (const slot of EXTERIOR_SLOTS) if (!taken.has(slot)) return slot;
  return null;
}

/** Owner UI: mount an item (record) or clear a slot (null). */
export function writeExteriorSlot(slot: string, record: ExteriorRecord | null): void {
  if (!docAlive() || !(EXTERIOR_SLOTS as readonly string[]).includes(slot)) return;
  boundDoc!.transact(() => {
    if (record) exteriorMap!.set(slot, record);
    else exteriorMap!.delete(slot);
  });
}
