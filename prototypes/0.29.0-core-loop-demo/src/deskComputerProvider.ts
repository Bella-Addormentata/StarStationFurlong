/**
 * 🖥️ Desk computer — room-management provider SEAM (#33 Stage B)
 *
 * The desk computer's focused UI (devices.ts createDeskComputerUI) needs
 * to reach INTO main.ts's live session state: the room doc's players map,
 * roomInfo (owner + accessMode + name), the local player id, the invite
 * mint, and the shared owner-check (isLocalPlayerRoomOwner).
 *
 * devices.ts is the world-agnostic UI factory. main.ts holds the live
 * network state. world.ts wires the two together at requestDeviceFocus
 * time. To avoid a devices.ts → main.ts import (main.ts imports devices,
 * not the other way — a cycle would break the Vite build), we use the
 * SAME pattern editMode.ts uses for its owner gate:
 *
 *   - THIS module exports a module-scoped provider slot
 *     (`setRoomManagementProvider` + `getRoomManagementProvider`),
 *   - main.ts REGISTERS the real implementation at init,
 *   - world.ts CONSUMES the provider when building the desk computer's
 *     deps, and creates a fresh dep bundle per focus.
 *
 * Everything on the provider interface is a THIN adapter: getters return
 * live values, writes return a small verdict {ok, reason}. The DOM UI
 * calls them; the pure helpers (deskComputerManagement.ts) shape the data.
 *
 * A missing provider is a valid state (offline / boot / minimal build):
 * the desk UI degrades to the wall computer's read-only view, hiding the
 * management pane rather than throwing. See createDeskComputerUI for how
 * the null-provider path is handled.
 */

import type { AccessMode, RawRosterRow } from "./deskComputerManagement";

/** Verdict shape returned by every write on the provider — matches the
 *  editMode.RoomEditPermission literal so callers can pattern-match with
 *  a shared idiom (`if (v.ok) … else showReason(v.reason)`). */
export type ManagementVerdict = { ok: true } | { ok: false; reason: string };

/** The outcome of a mint request. `link` is present on success and passes
 *  the pure `isValidInviteLink` guard in the UI; `error` is present on
 *  failure (typically "Local node not reachable — launch the app (or Rust
 *  node) first."). */
export interface MintInviteResult {
  link?: string;
  error?: string;
}

/**
 * The live seam the desk-computer UI reaches through.
 *
 * Discipline:
 *  - Every method is either a pure GETTER (no side effects) or a WRITE
 *    that must self-check its own owner gate. The UI never assumes a
 *    write will succeed — it always inspects the returned verdict and
 *    paints the reason inline when refused.
 *  - Every string / number returned by a getter is honest live state —
 *    the UI treats these as trusted display data, not user input, so the
 *    getters must not surface unvalidated peer strings without labelling
 *    them (roster rows go through pure orderedRoster before rendering).
 *  - mintInvite is async; the UI shows a pending state while it awaits.
 */
export interface RoomManagementProvider {
  /** Stable per-install id of the local player. Matches getPlayerId(). */
  getLocalPlayerId(): string;

  /** Current owner id from roomInfo.owner (or the legacy 'Local-Clone'
   *  literal on pre-S2 rooms). Never null — offline sessions publish a
   *  sensible fallback so the pane always has something to show. */
  getOwnerId(): string;

  /** Human display label for an owner id (main.ts §2468 resolver). */
  resolveOwnerLabel(ownerId: string): string;

  /** True when the LOCAL player holds owner authority for the current
   *  room (main.ts §2483 isLocalPlayerRoomOwner). Consulted by the UI
   *  before each write attempt, and by the read-only pane sections that
   *  swap their "view" and "edit" affordances by owner. */
  isLocalOwner(): boolean;

  /** Current room display name from roomInfo.name. Empty string is a
   *  valid live value; the pane renders '(unnamed)' when empty. */
  getRoomName(): string;

  /** Current access mode from roomInfo.accessMode, LWW-normalized by
   *  the provider before returning (so the UI never sees a hostile
   *  value). Matches main.ts §5476 getRoomAccessMode. */
  getAccessMode(): AccessMode;

  /** Raw roster from the room doc's players map. `entry` is unknown —
   *  the UI runs it through pure orderedRoster before display. */
  getRosterRaw(): RawRosterRow[];

  /** Persist a new room name. The provider RE-CHECKS the owner gate at
   *  write time (a race between UI open and an owner change must not
   *  let a stale UI submit). `name` is already sanitized by the UI's
   *  pure sanitizeRoomName call. */
  setRoomName(name: string): ManagementVerdict;

  /** Persist a new access mode. Owner-gated the same way as setRoomName. */
  setAccessMode(mode: AccessMode): ManagementVerdict;

  /** Mint a bootstrap invite link for the current room. Async — talks
   *  to the local node's fingerprint endpoint. */
  mintInvite(): Promise<MintInviteResult>;
}

// ── Module-scoped seam ──────────────────────────────────────────────────────

let provider: RoomManagementProvider | null = null;

/** main.ts registers the real live implementation here at init. Later
 *  registrations replace the previous one — matches the setter-once
 *  idiom setRoomEditPermission uses (a re-registration would be a bug
 *  in main.ts's init order, not a legitimate hot-swap). */
export function setRoomManagementProvider(
  next: RoomManagementProvider | null,
): void {
  provider = next;
}

/** world.ts consumes this when building desk-computer deps. `null` is a
 *  valid state (main.ts hasn't registered yet, or the build is a minimal
 *  test harness) — the UI degrades to the wall-computer read-only view. */
export function getRoomManagementProvider(): RoomManagementProvider | null {
  return provider;
}
