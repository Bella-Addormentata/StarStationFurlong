/**
 * 🪟 Window LAYOUT sync (#80 S4) — a clone of doorLayoutDoc for WINDOWS.
 *
 * WHICH windows a room has — id → {wall, along, y, w, h, r} — lives in a
 * room-doc `windowLayout` Y.Map, so a joiner sees the host's windows on entry
 * and the owner's add / move / remove propagates to everyone. A window is a
 * rounded-rect hole cut in an octagon SIDE WALL (world.collectWindowOpenings →
 * buildOctagonHull), plus a glass pane; the same discipline as doorLayoutDoc /
 * furnitureDoc. Windows are OWNED here (unlike doors, whose position lives in
 * floorPlan) — this map is the sole source of a window's wall, position, size.
 *
 * Rebinds per join like furniture / doorLayout (main.ts T0 seam). Reads cross
 * the peer trust boundary → shape-guarded by isWindowLayoutRecord.
 */

import * as Y from 'yjs';

/** The two octagon SIDE walls (narrow-axis ∓/± faces) a window can sit on.
 *  Stored as the octagon SIDE, not a cardinal, so a window survives a room
 *  resize (which can flip which cardinals are the side walls). The editor maps
 *  the clicked cardinal → side at placement time. */
export type WindowWall = 'neg' | 'pos';

/** Default window size (metres) + corner radius — the editor seeds these. */
export const WINDOW_DEFAULT = { w: 3, h: 1.8, r: 0.4, y: 2 };

/** Serializable window record — one per window id (`w:<uuid>`). Plain JSON. */
export interface WindowLayoutRecord {
  id: string;
  wall: WindowWall;
  /** Along-wall position (world coord on the wall's long axis). */
  along: number;
  /** Centre height above the floor. */
  y: number;
  /** Opening width / height / corner radius. */
  w: number;
  h: number;
  r: number;
  enabled?: boolean;
}

let boundDoc: Y.Doc | null = null;
let windowLayoutMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[windowLayout] listener threw during doc notify:', err);
    }
  }
}

export function bindWindowLayoutDoc(doc: Y.Doc): void {
  boundDoc = doc;
  windowLayoutMap = doc.getMap('windowLayout');
  windowLayoutMap.observe(() => notify());
  notify();
}

export function subscribeWindowLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    windowLayoutMap !== null
  );
}

const WALLS: readonly WindowWall[] = ['neg', 'pos'];

/** Shape guard (doc reads cross a trust boundary — see module header). */
export function isWindowLayoutRecord(value: unknown): value is WindowLayoutRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<WindowLayoutRecord>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.wall === 'string' &&
    WALLS.includes(r.wall as WindowWall) &&
    Number.isFinite(r.along) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.w) &&
    (r.w as number) > 0 &&
    Number.isFinite(r.h) &&
    (r.h as number) > 0 &&
    Number.isFinite(r.r) &&
    (r.r as number) >= 0 &&
    (r.enabled === undefined || typeof r.enabled === 'boolean')
  );
}

/** Snapshot the whole window set as id → validated record (malformed skipped). */
export function readAllWindowLayout(): Map<string, WindowLayoutRecord> {
  const out = new Map<string, WindowLayoutRecord>();
  if (!docAlive()) return out;
  for (const [id, value] of windowLayoutMap!.entries()) {
    if (isWindowLayoutRecord(value) && value.id === id) out.set(id, value);
  }
  return out;
}

/** Number of entries (windows start EMPTY — no default seed). */
export function windowLayoutDocSize(): number {
  return docAlive() ? windowLayoutMap!.size : 0;
}

/** Publish one window (add / move). Owner-only in practice (editor-gated). */
export function writeWindowLayout(rec: WindowLayoutRecord): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    windowLayoutMap!.set(rec.id, rec);
  });
}

/** Remove one window from the shared set. */
export function deleteWindowLayout(id: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    windowLayoutMap!.delete(id);
  });
}
