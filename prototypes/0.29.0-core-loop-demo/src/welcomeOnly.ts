/**
 * 🛰️ Welcome only — a new install goes to the welcome room and nowhere else
 * (owner direction, 2026-11-12: "remove the system where a newcomer might
 * create their own new module on startup … funnel all newcomers through the
 * ssf welcome module only").
 *
 * Before this, a first run that got no answer from the default station within
 * 30 s booted its own home module instead, and every later start went there
 * too. Now an install is SEEKING the welcome room from its first start until
 * the room's shared state has reached this computer once:
 *
 *  - every start with no explicit link docks at the welcome room, a join and
 *    never a claim, and nothing falls back to the home module;
 *  - a start that gets no answer stays docked, says so, and keeps asking: the
 *    room fills in by itself when a holder of it answers;
 *  - "still seeking" outlives the page (a saved mark), since the identity is
 *    stored during the first run and a second start is no longer a first run.
 *
 * An explicit ?seed= link or Use-link still wins for that start: it is the
 * player's own choice of a room, and a join. The install that HOSTS the
 * welcome room (its home room IS the welcome room) and a build that ships no
 * welcome link are never seeking, and boot home as before. Once the welcome
 * room has been reached the install is a returning one: it resumes the room it
 * was last in, and its own module is made when it asks for one (a door
 * keypad's PROVISION NEW MODULE) or when a later start has nowhere to resume.
 *
 * This file is the rules, pure; main.ts `bootstrapNetworking` applies them.
 */

/** localStorage key of the mark: this install set out for the welcome room
 *  and has not reached it yet. Removed on arrival. */
export const WELCOME_PENDING_KEY = 'ssf-welcome-pending';

/** The slice of Storage the mark needs (a test passes its own). */
export interface MarkStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Whether the mark is saved. A store that cannot be read (privacy mode)
 *  holds none: the install is then seeking only while it is a first run. */
export function welcomeMarked(store: MarkStore | null | undefined): boolean {
  try {
    return store?.getItem(WELCOME_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

/** Save the mark (best effort). */
export function markWelcomePending(store: MarkStore | null | undefined): void {
  try {
    store?.setItem(WELCOME_PENDING_KEY, '1');
  } catch {
    /* privacy mode: seeking lasts this page only */
  }
}

/** Remove the mark: the welcome room has been reached. */
export function clearWelcomePending(store: MarkStore | null | undefined): void {
  try {
    store?.removeItem(WELCOME_PENDING_KEY);
  } catch {
    /* privacy mode */
  }
}

export interface WelcomeFacts {
  /** The bundled welcome room's id; '' when the build ships no default station. */
  welcomeRoomId: string;
  /** This install's own home room id. The welcome room's host has the same. */
  homeRoomId: string;
  /** No identity was stored when the page loaded. */
  firstRun: boolean;
  /** The saved mark ({@link welcomeMarked}). */
  marked: boolean;
  /** This page has seen the welcome room's shared state arrive. */
  reached: boolean;
}

/** Whether this install is still on its way to the welcome room. */
export function seekingWelcome(f: WelcomeFacts): boolean {
  if (!f.welcomeRoomId || f.welcomeRoomId === f.homeRoomId) return false;
  return !f.reached && (f.firstRun || f.marked);
}

/**
 * Whether the welcome room's own state is in a replica: its `roomInfo` owner
 * and name, which the room has held since its host first opened it. This is
 * the arrival. A post-link sync alone is not: two installs that are both
 * still waiting can link to each other, and neither brings the room.
 */
export function welcomeStateHere(roomInfo: { has(key: string): boolean }): boolean {
  return roomInfo.has('owner') && roomInfo.has('name');
}

/** Where a boot goes.
 *  - `explicit`: the override the player gave (?seed=, Use-link), a join;
 *  - `dock`: the welcome room, a join that waits for its state;
 *  - `resume`: the room this install was last in (a returning install);
 *  - `home`: this install's own module, claimed (a returning install with
 *    nowhere to resume, the welcome room's host, or a build with no welcome
 *    link). */
export type BootRoute = 'explicit' | 'dock' | 'resume' | 'home';

/**
 * The one rule for where a boot goes. `overrideRoomId` is the pending
 * override's room, or null when there is none; `hasLastRoom` says a resume
 * target is saved. While seeking, an override that IS the welcome room (the
 * docking's own, kept for Retry-node, or the welcome pass pasted by hand) is
 * the docking again, so it waits and is told apart from a link elsewhere; a
 * saved last room is not resumed, and nothing routes home.
 */
export function bootRoute(
  seeking: boolean,
  overrideRoomId: string | null,
  welcomeRoomId: string,
  hasLastRoom: boolean,
): BootRoute {
  if (seeking) {
    return overrideRoomId !== null && overrideRoomId !== welcomeRoomId ? 'explicit' : 'dock';
  }
  if (overrideRoomId !== null) return 'explicit';
  return hasLastRoom ? 'resume' : 'home';
}

/** How long the first wait for the welcome room's state lasts before the game
 *  says it has not answered: a first cross-internet dial (DHT lookup, hole
 *  punch), the ACCESS app's own "up to ~30s". Nothing is held while it runs. */
export const WELCOME_FIRST_WAIT_MS = 30_000;
/** The longest wait between two asks while the welcome room stays silent. */
export const WELCOME_SEEK_CAP_MS = 300_000;

/**
 * How long round `round` (0, 1, 2, …) of the seek waits before asking again:
 * 30 s, 1 min, 2 min, 4 min, then 5 min for as long as it takes. Each ask is
 * one sync handshake to the player's own node, carrying the pass's hints; the
 * node dials every hint it is not already dialing, so an ask during a dial is
 * free and the pace is the node's own dial ladder at the fastest.
 */
export function welcomeSeekDelayMs(round: number): number {
  const n = Number.isFinite(round) ? Math.max(0, Math.floor(round)) : 0;
  // 2 ** 4 already passes the cap; the clamp keeps a huge round finite.
  return Math.min(WELCOME_SEEK_CAP_MS, WELCOME_FIRST_WAIT_MS * 2 ** Math.min(n, 4));
}

/** The line once the first wait ends with no answer. */
export function welcomeWaitingLine(name: string): string {
  return `⏳ ${name} has not answered yet. Your computer keeps trying, and this room fills in by itself when it answers. Until then it is empty.`;
}

/** The line after a later ask that still found nothing. */
export function welcomeStillWaitingLine(name: string): string {
  return `⏳ Still trying to reach ${name}.`;
}

/** The line when the docking could not start at all (the player's own node
 *  did not take the join): the game tries again by itself. */
export function welcomeRetryLine(name: string): string {
  return `⚠️ The link to ${name} could not start. Your computer tries again by itself.`;
}

/** The line on arrival. */
export function welcomeArrivedLine(name: string): string {
  return `🛰️ Welcome aboard ${name}. Any door's keypad can PROVISION NEW MODULE when you want a room of your own.`;
}
