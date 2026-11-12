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
 * This file is the rules, pure; main.ts applies them: `bootstrapNetworking`
 * picks the room, and every welcome-room session of a seeking install runs
 * the seek (`seekWelcome`), whichever way the player came into the room.
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

/** What one welcome-room session of a seeking install needs for its seek
 *  (main.ts hands these in; a test passes its own). */
export interface WelcomeSeekDeps {
  /** The welcome room's name, for the lines. */
  name: string;
  /** Wait up to `ms` for the room's state to land; resolves either way. */
  wait(ms: number): Promise<void>;
  /** Settles when this session's link to the player's own node is lost (the
   *  node went away); pending for good otherwise. */
  linkLost: Promise<void>;
  /** Ask again: one sync handshake to the player's own node. */
  ask(): void;
  /** Whether the welcome room's state is here now; records the arrival. */
  arrived(): boolean;
  /** Whether this session is still the live one. */
  current(): boolean;
  say(line: string): void;
}

/** How a session's seek ended. It never ends while the room stays silent. */
export type WelcomeSeekEnd = 'arrived' | 'superseded' | 'link-lost';

/**
 * The seek of ONE welcome-room session of an install still on its way there,
 * by whichever path the session began (the docking at a start, Retry-node, a
 * pass, a room swap that fell back here): wait the first wait, say the room
 * has not answered, then ask again and wait at welcomeSeekDelayMs's pace for
 * as long as it takes. It ends when the room's state arrives, when the
 * session is no longer the live one, or when the link to the player's own
 * node is lost under it — asking a closed link would reach nobody, so the
 * caller docks afresh instead of saying it keeps trying.
 */
export async function seekWelcome(deps: WelcomeSeekDeps): Promise<WelcomeSeekEnd> {
  const lost = deps.linkLost.then(() => true);
  for (let round = 0; ; round++) {
    // The join itself was the first ask.
    if (round > 0) deps.ask();
    const linkLost = await Promise.race([deps.wait(welcomeSeekDelayMs(round)).then(() => false), lost]);
    if (deps.arrived()) return 'arrived';
    if (!deps.current()) return 'superseded';
    if (linkLost) return 'link-lost';
    deps.say(round === 0 ? welcomeWaitingLine(deps.name) : welcomeStillWaitingLine(deps.name));
  }
}

/** What follows a lost link needs (main.ts hands these in; a test its own). */
export interface LostLinkDeps {
  /** Resolves once no room swap is under way; at once when none is. */
  swapEnded(): Promise<void>;
  /** Whether the session whose link was lost is still the live one. */
  current(): boolean;
  /** Leave that session: its transport is closed for good. */
  leave(): Promise<void>;
  /** Arm the docking's retry. */
  retry(): void;
}

/**
 * What follows a seek that ended `link-lost`: the dead session is left and
 * the docking's retry is armed. A room swap under way is waited out first,
 * since it owns the session until it ends. It may fail on the closed link
 * and restore or strand by itself; or it may finish with the dead session
 * still the live one (the link closed after its join, while it waited for
 * the room's state or lifted the curtain), and that session is then left
 * here: the retry does nothing while a session is live, so nothing would
 * dock again. The retry is armed whichever way it went, and only after the
 * leave, so its timer never finds a session that is about to go.
 */
export async function recoverLostLink(deps: LostLinkDeps): Promise<void> {
  try {
    await deps.swapEnded();
    if (deps.current()) await deps.leave();
  } finally {
    deps.retry();
  }
}

/** How a pass is read and written for {@link welcomePassToKeep}. */
export interface PassCodec<B> {
  /** A pass (a link or a bare seed) as a bootstrap; null when unreadable. */
  decode(pass: string): B | null;
  encode(boot: B): string;
  /** `held` with `extra`'s routes beside its own (roomCap.ts withPassRoutes). */
  withRoutes(held: B, extra: B): B;
}

/**
 * The welcome room's pass an arrival files in MY ROOMS. With no pass of the
 * player's own it is the bundled link. A pass the player already holds to the
 * room, or supplied for this docking (?seed=), STANDS, as it does for the
 * docking itself: it may name a holder of the room the bundled pass does not,
 * and that holder may be how this install got in. The bundled pass's routes
 * ride beside its own, so a later visit tries both.
 *
 * Never the live session's bootstrap: that one is bridged through the
 * player's own node and names this computer and its addresses, and the pass
 * in MY ROOMS is what the station atlas hands on for the room.
 */
export function welcomePassToKeep<B extends { roomId: string }>(
  own: string | null | undefined,
  bundled: string,
  codec: PassCodec<B>,
): string {
  if (!own || own === bundled) return bundled;
  try {
    const held = codec.decode(own);
    const extra = codec.decode(bundled);
    if (!held || !extra || held.roomId !== extra.roomId) return bundled;
    return codec.encode(codec.withRoutes(held, extra));
  } catch {
    return own; // it could not be rewritten: the player's pass stays as it is
  }
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

/** The line when the player's own node stops answering while the install
 *  waits in the welcome room: the docking starts again once it is back. */
export function welcomeNodeLostLine(name: string): string {
  return `⚠️ Your computer's own node stopped answering, so the link to ${name} is down. It starts again by itself when the node is back.`;
}

/** The line on arrival. */
export function welcomeArrivedLine(name: string): string {
  return `🛰️ Welcome aboard ${name}. Any door's keypad can PROVISION NEW MODULE when you want a room of your own.`;
}
