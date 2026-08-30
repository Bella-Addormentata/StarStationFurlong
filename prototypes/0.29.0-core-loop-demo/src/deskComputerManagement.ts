/**
 * 🖥️ Desk computer — room-management PURE helpers (#33 Stage B)
 *
 * The desk computer's focused DOM UI (devices.ts createDeskComputerUI) paints
 * everything the wall computer shows PLUS a room-management pane: rename,
 * invite mint / copy, peer roster, access-mode selector. This module holds
 * the PURE data transforms behind that pane — validation, sanitization and
 * ordering — so the DOM adapter stays a thin painter and every rule the
 * management pane enforces is exercised by vitest without a browser
 * (see deskComputerManagement.test.ts).
 *
 * Discipline (same as wallComputerMap.ts):
 *  - no DOM / no globals / no window / no fetch / no localStorage;
 *  - honest data only — a hostile / unvalidated input (an atlas gossip payload,
 *    a Y.Doc value from a peer, a user-typed field) is either sanitized to a
 *    safe shape or rejected;
 *  - single source of truth — the pane's rules (name length cap, access-mode
 *    LWW normalization, roster ordering) live here, and the DOM adapter and
 *    the write seam consume the same helpers so the ruleset cannot drift.
 *
 * These rules mirror what the network panel and phone HUD already enforce:
 *   - maxLength 24 for room names (main.ts §5192 — the network-panel rename
 *     input caps input.maxLength = 24; the desk pane must not accept longer
 *     names that the network panel would silently truncate);
 *   - access-mode LWW normalization (main.ts §5478 — getRoomAccessMode treats
 *     any value that is not 'public' | 'keyed' as 'pass', so a peer setting
 *     an out-of-envelope mode collapses to 'pass' rather than jamming the UI);
 *   - roster ordering by joinedAt ascending (main.ts §2530 — renderPhonePlayersList
 *     sorts CLONES SEEN the same way, so the desk roster reads with the same
 *     grain the phone does).
 *
 * See brainstorming/device-maps-plan.md §2 Stage B for the surface-level plan.
 */

// ── 🎯 Room-name sanitization ─────────────────────────────────────────────────

/** The maximum accepted length of a room-display name.
 *  Matches the network panel's rename `input.maxLength = 24` (main.ts §5192):
 *  keeping the same cap here means the desk pane and the network panel never
 *  disagree about whether a name is admissible — one refuses the same names
 *  the other refuses, and no path silently truncates the persisted value. */
export const ROOM_NAME_MAX_LENGTH = 24;

/**
 * Sanitize a user-typed room name into a valid persist value or reject it.
 *
 * Rules (same as the network panel's rename flow — main.ts §5197 `saveChanges`):
 *  - trim leading / trailing whitespace;
 *  - reject non-strings (a hostile DOM input.value can be `undefined`);
 *  - reject the empty string (the network panel skips the write when trimmed
 *    is empty; the desk pane refuses at input time so the ruling is louder);
 *  - cap at ROOM_NAME_MAX_LENGTH — a longer entry is HARD-truncated (silent
 *    truncation was chosen deliberately: the input already ships with a
 *    maxLength cap, so an overflow here means an automated / paste-in edit
 *    tried to push past the cap and the pane must not persist the whole thing).
 *
 * Returns the sanitized string when acceptable, or `null` when the input
 * cannot be persisted. The DOM adapter uses `null` as its refuse signal.
 */
export function sanitizeRoomName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, ROOM_NAME_MAX_LENGTH);
}

// ── 🔐 Access mode normalization ─────────────────────────────────────────────

/**
 * The room's ENTRY policy, gossiped in roomInfo.accessMode. Mirrors the
 * literal-union main.ts §5468 declares — kept in sync as new modes ship.
 *
 *  - public : anyone enters this room;
 *  - pass   : anyone with the shared bootstrap link enters (today's default);
 *  - keyed  : granted keys only (enforced once keyed identity ships — see
 *             brainstorming/keyed-identity-contacts-plan.md §9).
 */
export type AccessMode = "public" | "pass" | "keyed";

/** Every mode a pane can render, in the order the selector should offer them. */
export const ACCESS_MODES: readonly AccessMode[] = ["public", "pass", "keyed"];

/**
 * Cast an unvalidated value (Y.Map read from a peer, hostile localStorage)
 * to a valid AccessMode.
 *
 * Discipline: matches main.ts §5476 `getRoomAccessMode`'s LWW read — any value
 * that is not the exact string 'public' or 'keyed' collapses to 'pass'
 * (today's default). Case-sensitive on purpose: a peer that writes 'PUBLIC'
 * (a wrong case) is a bug not a permission, so the pane treats it as unknown
 * rather than quietly promoting it.
 */
export function normalizeAccessMode(raw: unknown): AccessMode {
  return raw === "public" || raw === "keyed" ? raw : "pass";
}

/**
 * Human-readable description of an access mode. Mirrors main.ts §5470
 * `ACCESS_MODE_COPY` word-for-word — the desk pane and the ACCESS app say
 * the same thing about the same mode so the player never sees a surface
 * disagree with itself.
 */
export function describeAccessMode(mode: AccessMode): string {
  switch (mode) {
    case "public":
      return "PUBLIC · anyone can enter this room.";
    case "pass":
      return "PASS · anyone with the link can enter (default).";
    case "keyed":
      return "KEYED · granted keys only (enforced once keyed identity ships).";
  }
}

// ── 👥 Peer roster ordering ──────────────────────────────────────────────────

/**
 * A single roster row after ordering — the shape the DOM adapter renders.
 * Nothing here is DOM-typed; the adapter walks the list and paints
 * textContent-only rows (names are remote-controlled strings, never innerHTML).
 */
export interface RosterEntry {
  /** The player id (matches getPlayerId() / the Y.Map key). */
  id: string;
  /** Display name (falls back to 'Unknown-Clone' when the peer's entry omits it). */
  name: string;
  /** Millisecond epoch of the first join (null when the entry omitted it). */
  joinedAt: number | null;
  /** Outfit id the peer last mirrored into their entry (falls back to 'default'). */
  outfitId: string;
  /** True when this row is the local player — the pane appends " (you)". */
  isMe: boolean;
  /** True when this row holds owner authority (matches ownerId exactly,
   *  or the legacy 'Local-Clone' owner rule). Legacy joint-ownership via
   *  venture shareholders is NOT computed here — that requires a signing
   *  key check the pure module cannot perform (main.ts owns the check). */
  isOwner: boolean;
  /** True when the entry carries an identity pubkey + name↔key self-cert
   *  (both fields are non-empty strings) — the roster's ★ FRIEND / + FRIEND
   *  affordances key off this the same way renderPhonePlayersList does. */
  hasKeyCert: boolean;
  /** True when the entry is missing / not an object. Kept separate from
   *  hasKeyCert so a keyless-but-valid entry still renders as a normal row. */
  malformed: boolean;
}

/** One raw row as read from the Y.Map. `entry` is `unknown` because peer
 *  writes are UNVALIDATED — the ordering helper is the last line of defence
 *  before the row hits the DOM adapter. */
export interface RawRosterRow {
  id: string;
  entry: unknown;
}

/** Fallback display name for a roster row whose entry omits it. Mirrors the
 *  literal main.ts §2540 renderPhonePlayersList uses so both surfaces label a
 *  keyless / nameless entry the same way. */
const UNKNOWN_CLONE_NAME = "Unknown-Clone";

/** True when a value smells like a legitimate PlayerEntry object (main.ts
 *  §2420 interface). Peer writes cannot be trusted — a hostile / older client
 *  may put anything in the map, and hostile-shaped entries silently jam a
 *  DOM render that assumes .name is a string.  */
function isPlainRosterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when both fields of the name↔key self-cert are present as non-empty
 *  strings (renderPhonePlayersList's exact test — the ★ FRIEND affordance
 *  keys off it, and so does the roster's role column). */
function hasSelfCert(entry: Record<string, unknown>): boolean {
  const key = entry.keyB64;
  const sig = entry.keySig;
  return (
    typeof key === "string" && key.length > 0 &&
    typeof sig === "string" && sig.length > 0
  );
}

/**
 * Order a raw roster from the room doc's players map into the rows the desk
 * pane paints. Rows are sorted by joinedAt ascending (main.ts §2530 —
 * matches CLONES SEEN); missing / non-numeric joinedAt sorts to 0, which
 * lands those rows FIRST (they read as "was here since forever" — the same
 * outcome the phone list settles on when a peer entry omits joinedAt).
 *
 * ownerId is the current roomInfo.owner value. This helper labels a row as
 * `isOwner: true` for an exact match OR for the pre-S2 'Local-Clone' owner
 * (those rooms are owner-equivalent for everyone — the ruling in main.ts
 * §2483 isLocalPlayerRoomOwner). Venture joint-ownership is NOT computed
 * here (needs a signing-key check the pure module cannot perform); the
 * write path stays owner-gated in the provider seam either way.
 *
 * The list keeps every input row — even malformed ones — with `malformed:
 * true` so the DOM adapter can render them as `Unknown-Clone (bad entry)`
 * without silently dropping a peer's presence.
 */
export function orderedRoster(
  raw: readonly RawRosterRow[],
  myId: string,
  ownerId: string,
): RosterEntry[] {
  const rows: RosterEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row.id !== "string" || row.id.length === 0) continue;
    if (!isPlainRosterObject(row.entry)) {
      rows.push({
        id: row.id,
        name: UNKNOWN_CLONE_NAME,
        joinedAt: null,
        outfitId: "default",
        isMe: row.id === myId,
        // Legacy 'Local-Clone' owner is owner-equivalent for every viewer
        // (main.ts §2483) — but that is a viewer-side check, not a row
        // attribute. isOwner is a strict per-row identity check.
        isOwner: row.id === ownerId,
        hasKeyCert: false,
        malformed: true,
      });
      continue;
    }
    const entry = row.entry;
    const rawName = entry.name;
    const name = typeof rawName === "string" && rawName.length > 0
      ? rawName
      : UNKNOWN_CLONE_NAME;
    const rawJoined = entry.joinedAt;
    const joinedAt = typeof rawJoined === "number" && Number.isFinite(rawJoined)
      ? rawJoined
      : null;
    const rawOutfit = entry.outfitId;
    const outfitId = typeof rawOutfit === "string" && rawOutfit.length > 0
      ? rawOutfit
      : "default";
    rows.push({
      id: row.id,
      name,
      joinedAt,
      outfitId,
      isMe: row.id === myId,
      isOwner: row.id === ownerId,
      hasKeyCert: hasSelfCert(entry),
      malformed: false,
    });
  }
  // Stable sort by joinedAt ascending, missing (null) => 0 (renders first).
  // Array.prototype.sort is stable per spec since ES2019 — a tie by joinedAt
  // preserves the raw input order so the roster reads deterministically.
  rows.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  return rows;
}

// ── 🔗 Invite link shape guard ───────────────────────────────────────────────

/**
 * Validate a bootstrap invite link shape. mintBootstrapLink (main.ts §4916)
 * returns one of two carriers:
 *   1. `${origin}${pathname}?seed=<encoded>` — for shareable http(s) origins;
 *   2. `ssf://room?seed=<encoded>` — for tauri:// / non-shareable origins.
 *
 * The desk pane's COPY affordance echoes the minted link into a text field;
 * the guard exists so:
 *   - the pane refuses to copy an empty / rejected mint (mintBootstrapLink
 *     returns `{ error }` when the local node is unreachable);
 *   - a hostile / stale value read out of the ACCESS app's input never leaks
 *     an unrelated URL (e.g. javascript:) through the copy action.
 *
 * The `?seed=<non-empty>` query parameter is REQUIRED — a URL without a seed
 * does not bootstrap a network peer and would be an inert paste.
 */
export function isValidInviteLink(link: unknown): boolean {
  if (typeof link !== "string" || link.length === 0) return false;
  // ssf://room?seed=… carrier — the non-shareable-origin case.
  if (link.startsWith("ssf://room?")) {
    return hasNonEmptySeedParam(link.slice("ssf://room".length));
  }
  // http:// or https:// carriers — the shareable-origin case. URL parsing
  // is the safest way to catch a hostile scheme (javascript:, data:) — but
  // WHATWG URL requires an origin, so we route through the URL constructor.
  if (link.startsWith("http://") || link.startsWith("https://")) {
    try {
      const u = new URL(link);
      return hasNonEmptySeedParam(`?${u.searchParams.toString()}`);
    } catch {
      return false;
    }
  }
  return false;
}

function hasNonEmptySeedParam(queryString: string): boolean {
  // URLSearchParams is happy with a leading '?'; drop it for consistency.
  const q = queryString.startsWith("?") ? queryString.slice(1) : queryString;
  const params = new URLSearchParams(q);
  const seed = params.get("seed");
  return typeof seed === "string" && seed.length > 0;
}

// ── 🪪 Ownership label decoration ────────────────────────────────────────────

/**
 * Produce the "OWNER" row's display string given the owner's resolved
 * display name and whether this viewer holds owner authority. The helper
 * appends " (you)" ONLY when isMine is true, matching the phone roster's
 * convention (main.ts §2540 renderPhonePlayersList).
 *
 * `ownerName` should already be resolved through main.ts §2468
 * `resolveOwnerLabel` — that resolver handles the legacy 'Local-Clone'
 * literal and shortens a bare UUID; keeping the two concerns separate lets
 * this helper stay pure (no doc reads) while the resolver stays a viewer
 * concern (needs live Y.Map state).
 */
export function ownershipLabel(ownerName: string, isMine: boolean): string {
  const base = ownerName && ownerName.length > 0 ? ownerName : "Unknown-Clone";
  return isMine ? `${base} (you)` : base;
}
