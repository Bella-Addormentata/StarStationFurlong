/**
 * 🧍 Local presence — is the LOCAL player standing in the room, and where?
 *
 * World writes this once per frame from its own isPlayerActive() and the
 * player's position; anything that must react to the fox ENTERING a room
 * (the party speaker striking up, say) reads it here instead of reaching for
 * `window.world`, which goes stale the moment a room swap builds a new World.
 *
 * Pure state, no three.js: cheap to import from furniture builders and cheap
 * to drive from tests.
 */

let inRoom = false;
let px = 0;
let pz = 0;
const subs = new Set<(inRoom: boolean) => void>();

/** Called by World every frame; only a CHANGE of presence notifies. */
export function setLocalPresence(nowInRoom: boolean, x: number, z: number): void {
  px = x;
  pz = z;
  if (nowInRoom === inRoom) return;
  inRoom = nowInRoom;
  for (const cb of [...subs]) {
    try {
      cb(inRoom);
    } catch (e) {
      console.error("[localPresence] listener threw:", e);
    }
  }
}

export function isLocalPlayerInRoom(): boolean {
  return inRoom;
}

/** The local player's world XZ as of the last frame (0,0 before any). */
export function localPlayerXZ(): { x: number; z: number } {
  return { x: px, z: pz };
}

export function subscribeLocalPresence(cb: (inRoom: boolean) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
