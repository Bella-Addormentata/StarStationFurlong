/**
 * Player identity — per-install stable id + display name (issue #20 S2).
 *
 * The player id is a UUID minted once per browser install and persisted in
 * localStorage. It is deliberately NOT the 8-byte movement-lane id from
 * issue #22: that id is per-CONNECTION (blake3 of node id + tab addr), so it
 * changes across sessions/transports and cannot key durable data like the
 * room doc's `players` map. Bridging lane ids → player ids is S3 (presence)
 * work; until then the two identities coexist on separate lanes.
 *
 * NOT security (deliberate, per the S2 plan in
 * brainstorming/phone-apps-breakdown.md): nothing stops a peer from claiming
 * any id or name. Signed identity / key custody is deferred (v006 §10.3).
 */

const ID_STORAGE_KEY = 'ssf-player-id';
const NAME_STORAGE_KEY = 'ssf-player-name';
const DEFAULT_ROOM_STORAGE_KEY = 'ssf-default-room-id';

/** Same cap as the room-name editor — keeps phone rows from overflowing. */
export const PLAYER_NAME_MAX_LENGTH = 24;

// Session caches: localStorage throws in some privacy modes, and identity
// must still be STABLE within a tab session (one id per boot, edits stick)
// even when persistence is unavailable.
let cachedPlayerId: string | null = null;
let cachedPlayerName: string | null = null;
let cachedDefaultRoomId: string | null = null;

/**
 * Mint a UUID for the player id. crypto.randomUUID is unavailable outside
 * secure contexts (and on older engines) — identity here is UNIQUENESS, not
 * security (see the header note), so a Math.random/Date-seeded v4 shape is an
 * acceptable fallback; the whole phone UI must not die on a missing API.
 */
function mintPlayerUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through to the non-crypto shape */ }
  let seed = Date.now();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (seed + Math.random() * 16) % 16 | 0;
    seed = Math.floor(seed / 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Per-install player id (UUID). Minted + persisted on first call. */
export function getPlayerId(): string {
  if (cachedPlayerId) return cachedPlayerId;
  try {
    const existing = localStorage.getItem(ID_STORAGE_KEY);
    if (existing) {
      cachedPlayerId = existing;
      return existing;
    }
  } catch { /* privacy mode — mint a session-scoped id below */ }
  const minted = mintPlayerUuid();
  cachedPlayerId = minted;
  try {
    localStorage.setItem(ID_STORAGE_KEY, minted);
  } catch { /* session-scoped id is the best we can do */ }
  return minted;
}

/**
 * Per-install DEFAULT room id — the "home" room you boot into. Random +
 * persisted so two fresh installs NEVER collide on a shared id.
 *
 * Dev-stage fix: everyone used to default to the literal `furlong-lobby`, so a
 * pass for one install's lobby matched the other's own lobby — the joiner saw
 * "YOU ARE HERE" and its node short-circuited the dial to itself. A random id
 * makes every install's home room unique, so a home-room pass bridges two
 * installs directly. Only the ID is unique; the DISPLAY name is still "Lobby"
 * (roomInfo.name). Minted once + cached, mirroring getPlayerId. (The id system
 * is expected to change again later — see brainstorming/.)
 */
export function getDefaultRoomId(): string {
  if (cachedDefaultRoomId) return cachedDefaultRoomId;
  try {
    const existing = localStorage.getItem(DEFAULT_ROOM_STORAGE_KEY);
    if (existing) { cachedDefaultRoomId = existing; return existing; }
  } catch { /* privacy mode — mint a session-scoped id below */ }
  const minted = mintDefaultRoomId();
  cachedDefaultRoomId = minted;
  try { localStorage.setItem(DEFAULT_ROOM_STORAGE_KEY, minted); } catch { /* session-scoped */ }
  return minted;
}

function mintDefaultRoomId(): string {
  const bytes = new Uint8Array(6);
  try { crypto.getRandomValues(bytes); }
  catch { for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256); }
  return 'home-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Default display name: Clone-XXXX from the last 4 hex chars of the id. */
function defaultPlayerName(): string {
  const hex = getPlayerId().replace(/-/g, '').slice(-4).toUpperCase();
  return `Clone-${hex}`;
}

/** Collapse whitespace, trim, cap length — a name is one short line. */
function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, PLAYER_NAME_MAX_LENGTH);
}

/** Current display name (saved name, else the Clone-XXXX default). */
export function getPlayerName(): string {
  if (cachedPlayerName) return cachedPlayerName;
  try {
    const saved = localStorage.getItem(NAME_STORAGE_KEY);
    if (saved) {
      const normalized = normalizeName(saved);
      if (normalized) {
        cachedPlayerName = normalized;
        return normalized;
      }
    }
  } catch { /* privacy mode — default below */ }
  return defaultPlayerName();
}

/**
 * Persist a new display name. Blank/whitespace input is rejected — the
 * current name stays in effect, so a stray empty save can't blank the
 * identity row. Returns the name now in effect (normalized).
 */
export function setPlayerName(name: string): string {
  const normalized = normalizeName(name);
  if (!normalized) return getPlayerName();
  cachedPlayerName = normalized;
  try {
    localStorage.setItem(NAME_STORAGE_KEY, normalized);
  } catch { /* name lives for this tab session only */ }
  return normalized;
}
