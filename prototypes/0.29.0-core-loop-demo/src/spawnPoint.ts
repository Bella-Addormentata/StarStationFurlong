/**
 * 🧬 Spawn-point preference (owner request): which clone vat is MINE in each
 * room. Local-only, like the room inventory — where *my* clone decants is my
 * device's business, not shared doc state. A room with vats but no saved
 * choice uses the first vat found (findSpawnVat's order); a room with no
 * vats keeps the legacy mid-room spawn.
 */

const KEY = 'ssf-spawn-vat';
const MAX_ENTRIES = 64;

function readAll(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {};
  } catch { return {}; }
}

/** The vat item id I chose as my spawn point in this room, if any. */
export function preferredSpawnVat(roomId: string): string | null {
  const v = readAll()[roomId];
  return typeof v === 'string' && v ? v : null;
}

/** Set (or clear, with null) my spawn-point vat for a room. */
export function setPreferredSpawnVat(roomId: string, itemId: string | null): void {
  try {
    const all = readAll();
    if (itemId) all[roomId] = itemId;
    else delete all[roomId];
    const keys = Object.keys(all);
    // Oldest-key trim (insertion order) — a bound, not a policy.
    while (keys.length > MAX_ENTRIES) delete all[keys.shift()!];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* session-only */ }
}
