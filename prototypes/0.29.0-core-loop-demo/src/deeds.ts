/**
 * 🏠 Deeds — the personal real-estate ledger (Ventures app REAL ESTATE section)
 *
 * There is no global ownership registry: `roomInfo.owner` lives inside each
 * room's own doc and the client holds ONE doc at a time. So the deeds list
 * accumulates the way the venture ledger and the station atlas do — by
 * VISITATION: every room you join that names YOU its personal owner upserts a
 * deed entry here (localStorage); a recorded room seen with a DIFFERENT owner
 * drops out (you handed its deed over, or a peer claimed it). Complete in
 * practice, not just best-effort: you can only ever have BECOME an owner while
 * standing in the room, so every deed passed through a harvest moment. The V3
 * Registry anchor (#68) replaces walk-to-learn with shared truth.
 *
 * PERSONAL ownership only — venture property is deliberately NOT mirrored
 * here (it lists under each venture's PROPERTY section); a module both
 * personally owned AND venture-linked carries its venture tag on the deed.
 */

export interface DeedEntry {
  roomId: string;
  name: string;
  /** Venture this module was assigned to at harvest (office or property link). */
  ventureId?: string;
  ventureName?: string;
  /** True when the venture record here was the OFFICE — the charter holds the
   *  office's deed, so personal hand-over is refused there. */
  isOffice?: boolean;
  lastSeen: number;
}

const DEEDS_KEY = 'ssf-deeds-ledger';
const MAX_DEEDS = 64;

export function deedsLedger(): DeedEntry[] {
  try {
    const raw = localStorage.getItem(DEEDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is DeedEntry =>
      !!e && typeof e.roomId === 'string' && !!e.roomId && typeof e.name === 'string');
  } catch { return []; }
}

function writeDeeds(entries: DeedEntry[]): void {
  try {
    localStorage.setItem(DEEDS_KEY, JSON.stringify(entries.slice(0, MAX_DEEDS)));
  } catch { /* privacy mode — the list degrades to the current room only */ }
}

export function upsertDeed(entry: DeedEntry): void {
  const rest = deedsLedger().filter((e) => e.roomId !== entry.roomId);
  writeDeeds([entry, ...rest]);
}

export function removeDeed(roomId: string): void {
  const all = deedsLedger();
  const rest = all.filter((e) => e.roomId !== roomId);
  if (rest.length !== all.length) writeDeeds(rest);
}
