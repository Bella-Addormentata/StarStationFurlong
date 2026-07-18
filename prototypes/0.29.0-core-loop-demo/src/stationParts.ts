/**
 * 🔩 Station construction parts + build toggles (#62 P4)
 *
 * The dev-phase inventory behind the octagon build (plan §6.1): FLEX JOINT and
 * EXTENSION part counts, the two connection presets (RING LINK / HUB SPOKE),
 * the minted-module seeds ledger (building 9 rooms needs more than a clipboard
 * that holds one), and the walkthrough toggles (AUTO-ACCEPT MY MODULES, NORTH
 * DOOR unlock). All LOCAL (localStorage, per-install) — parts are a dev-phase
 * currency, not shared room truth. The requirement layer (robot arm / EVA,
 * issue #62 design ruling) will later gate WHO may assemble; this module only
 * tracks WHAT they have.
 */

import type { ConnectorSegment } from './adapter';

const PARTS_KEY = 'ssf-station-parts';       // { flex: n, ext: n, adapter: n }
const LEDGER_KEY = 'ssf-module-ledger';      // [{ roomId, seed, mintedAt }]
const PRESET_KEY = 'ssf-armed-preset';       // 'ring' | 'spoke' | ''
const AUTO_ACCEPT_KEY = 'ssf-auto-accept';   // '1' when on
const NORTH_DOOR_KEY = 'ssf-north-door';     // '1' when unlocked

export type PartKind = 'flex' | 'ext' | 'adapter';
export type PresetId = 'ring' | 'spoke';

export interface LedgerEntry {
  roomId: string;
  seed: string;
  mintedAt: number;
}

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[stationParts] listener threw:', e); }
  }
}
export function subscribeStationParts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Parts counts ─────────────────────────────────────────────────────────────

function loadParts(): { flex: number; ext: number; adapter: number } {
  try {
    const raw = localStorage.getItem(PARTS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        flex: Number.isFinite(p?.flex) ? Math.max(0, Math.floor(p.flex)) : 0,
        ext: Number.isFinite(p?.ext) ? Math.max(0, Math.floor(p.ext)) : 0,
        adapter: Number.isFinite(p?.adapter) ? Math.max(0, Math.floor(p.adapter)) : 0,
      };
    }
  } catch { /* privacy mode / corrupt — start empty */ }
  return { flex: 0, ext: 0, adapter: 0 };
}

function saveParts(p: { flex: number; ext: number; adapter: number }): void {
  try { localStorage.setItem(PARTS_KEY, JSON.stringify(p)); } catch { /* session-only */ }
  notify();
}

export function partsCount(kind: PartKind): number {
  return loadParts()[kind];
}

export function addParts(kind: PartKind, n: number): void {
  const p = loadParts();
  p[kind] = Math.max(0, p[kind] + Math.floor(n));
  saveParts(p);
}

/** Consume one part; false (and no change) when none are left. */
export function consumePart(kind: PartKind): boolean {
  const p = loadParts();
  if (p[kind] <= 0) return false;
  p[kind] -= 1;
  saveParts(p);
  return true;
}

export function refundPart(kind: PartKind): void {
  addParts(kind, 1);
}

/** Consume every part a segment list needs, atomically — false when short
 *  (nothing consumed). Used by the preset prefill. */
export function consumeForSegments(segments: ConnectorSegment[]): boolean {
  const need = { flex: 0, ext: 0 };
  for (const s of segments) need[s.kind === 'flex' ? 'flex' : 'ext']++;
  const p = loadParts();
  if (p.flex < need.flex || p.ext < need.ext) return false;
  p.flex -= need.flex;
  p.ext -= need.ext;
  saveParts(p);
  return true;
}

export function refundForSegments(segments: ConnectorSegment[]): void {
  const p = loadParts();
  for (const s of segments) p[s.kind === 'flex' ? 'flex' : 'ext']++;
  saveParts(p);
}

// ── Presets (plan §6.1/§6.3 — two presets build all 12 octagon links) ────────

export function presetSegments(preset: PresetId): ConnectorSegment[] {
  return preset === 'ring'
    ? [
        { kind: 'flex', bendDeg: 22.5, stretch: 0 },
        { kind: 'ext', bays: 4, skin: 'solid' },
        { kind: 'flex', bendDeg: 22.5, stretch: 0 },
      ]
    : [
        { kind: 'flex', bendDeg: 0, stretch: 0 },
        { kind: 'ext', bays: 11, skin: 'solid' },
        { kind: 'flex', bendDeg: 0, stretch: 0 },
      ];
}

export function armedPreset(): PresetId | null {
  try {
    const v = localStorage.getItem(PRESET_KEY);
    return v === 'ring' || v === 'spoke' ? v : null;
  } catch { return null; }
}

export function setArmedPreset(preset: PresetId | null): void {
  try { localStorage.setItem(PRESET_KEY, preset ?? ''); } catch { /* session-only */ }
  notify();
}

// ── Minted-module seeds ledger ───────────────────────────────────────────────

export function moduleLedger(): LedgerEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is LedgerEntry => e && typeof e.roomId === 'string' && typeof e.seed === 'string',
    );
  } catch { return []; }
}

export function addToLedger(roomId: string, seed: string): void {
  const entries = moduleLedger().filter((e) => e.roomId !== roomId);
  entries.push({ roomId, seed, mintedAt: Date.now() });
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(entries)); } catch { /* session-only */ }
  notify();
}

export function ledgerHasRoom(roomId: string): boolean {
  return moduleLedger().some((e) => e.roomId === roomId);
}

// ── Walkthrough toggles ──────────────────────────────────────────────────────

export function autoAcceptEnabled(): boolean {
  try { return localStorage.getItem(AUTO_ACCEPT_KEY) === '1'; } catch { return false; }
}
export function setAutoAccept(on: boolean): void {
  try { localStorage.setItem(AUTO_ACCEPT_KEY, on ? '1' : '0'); } catch { /* session-only */ }
  notify();
}

export function northDoorUnlocked(): boolean {
  try { return localStorage.getItem(NORTH_DOOR_KEY) === '1'; } catch { return false; }
}
export function setNorthDoorUnlocked(on: boolean): void {
  try { localStorage.setItem(NORTH_DOOR_KEY, on ? '1' : '0'); } catch { /* session-only */ }
  notify();
}

// ── Mirror math (#62 P4 — the far side's record of the same physical chain) ──

/**
 * The same physical connector described from the FAR room's door: segments in
 * reverse order with flex bends NEGATED (traversing a circular arc backwards
 * reverses the heading change: Δheading(B→A) = −Δheading(A→B)); extensions
 * unchanged.
 */
export function mirrorSegments(segments: ConnectorSegment[]): ConnectorSegment[] {
  return [...segments].reverse().map((s) =>
    s.kind === 'flex'
      ? { kind: 'flex' as const, bendDeg: -(s.bendDeg ?? 0), stretch: s.stretch ?? 0 }
      : { kind: 'ext' as const, bays: s.bays, skin: s.skin },
  );
}
