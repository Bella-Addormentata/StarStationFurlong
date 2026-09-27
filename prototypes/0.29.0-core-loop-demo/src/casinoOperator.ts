/**
 * 🎰🪙 The room's one casino operator — the lease under which ONE browser
 * session operates every casino game in the room: the slot machines
 * (slotCroupier.ts), the coin pushers (pusherCroupier.ts) and, later, the
 * air-hockey entry fee. This module holds the election; the games hold the
 * work.
 *
 * ELECTION: a player's `bal:` is a whole value whichever game writes it, so
 * two sessions settling that player's spin and drop at once would each write
 * it, and the merge would keep only one of the two writes (a debit or a
 * payout would vanish). One session therefore takes the room's
 * `casino-operator` lease, waits OPERATOR_LEASE_SETTLE_MS for the doc to
 * converge, then works while it keeps the lease (renewed every
 * OPERATOR_LEASE_RENEW_MS, lapsing after OPERATOR_LEASE_MS). Every frame each
 * game's tick reports whether it NEEDS the room (slots: a machine to operate,
 * a round to wind down or a removed machine holding chips; pusher: a cabinet
 * or a pending drain, and the deed; a fee: an unsettled request) and runs the
 * election (electCasinoOperator), which takes the lease when no other session
 * may hold it and some game needs it, renews it, and lets it go once no game
 * needs it or once it is lost or lapsed. A game reporting no need neither
 * ends nor releases anything by itself: the record is deleted only when the
 * union of the needs is empty, so a pusher with nothing to do never takes the
 * room from a slot machine mid-round. The election is idempotent by state and
 * runs twice a frame (World ticks the slots, then the pushers); the second
 * call finds the take the first made, or the same hold-off. What each game
 * operates under the lease is its own: the slot holder operates the machines
 * whose bankroll its player owns (auto, or started by hand in a venture
 * room), the pusher holder every cabinet, the deed holder only. Every write
 * under the lease goes through stillOperates first, after the last await
 * and just before the transaction: a lease let go, lost or lapsed mid-settle
 * is never written behind, and work begun under one take never writes under
 * a later one (each take carries a fresh `tenure`).
 *
 * WHO THE RECORD NAMES: the holder's own player id (getPlayerId), and every
 * write under it is bound to that id — a slot payout comes out of a funding
 * config naming it, a stake or refund goes to the round's player, a pusher
 * drain or door empty goes to it. `slot-funding:<mid>` is a peer-writable
 * key: a config forged to name a victim's wallet is served by nobody but that
 * victim's own session, because only its session operates the machines whose
 * funding names its own id. That binding is why the lease is not widened to
 * "every machine the deed holder funds". A deed holder with two installs (two
 * player ids) therefore has the slot work of one install served only by that
 * install's session; the other install's session serves the pushers.
 *
 * WIND-DOWN: a round accepted on a machine this session no longer operates
 * keeps the lease until it is refunded: see slotCroupier.ts, WIND-DOWN. The
 * slot tick reports it as need.
 *
 * SPLITS: a Y.Map lease is not a mutex. Two sessions cut off from each other
 * could each take it and settle; when the docs merge, only one of each
 * balance write survives. Settling can't be made split-safe without an
 * authoritative ledger (the Registry-anchored chips), so a session on ANOTHER
 * device takes over a lease it has seen lapse only
 * OPERATOR_UNCLEAN_TAKEOVER_MS later, in case its holder is only cut off.
 * (Another device's record is taken as the deed holder's own whatever player
 * id it names: an install that restored the deed holder's identity key has a
 * player id of its own.) Tabs on one device share its local node, so they
 * take over as soon as the lease lapses (a reload, a closed tab). A session
 * that stops operating releases its lease, so a successor needn't wait; so
 * does one leaving the room, or the page (best effort on close). That window
 * guards only a lease this page has seen. One that sees no lease at all (cut
 * off from the operator, or joining from a cached copy of the room before its
 * live state arrives) takes it at once and operates after the settling wait,
 * which is enough only where the two are connected: each sees the other's
 * take, and the merge keeps one. So a split of any length that begins before
 * a device has seen the other's lease can put two operators in one room; once
 * it has, only a split outlasting the window can.
 *
 * CLOCKS: devices' clocks aren't synchronised, so a lease written on another
 * device is never judged by the expiry it claims: it lapses one
 * OPERATOR_LEASE_MS after this page last saw it renewed (leaseLapsesAt). Only
 * a tab on this device, which shares the clock, is also held to its own
 * expiry. The records are peer-writable: one claiming a far-future expiry
 * holds the room for one lease term, not forever. Every client watches the
 * renewals (World ticks the room on every client), and a panel asks the same
 * question: the pusher's DROP waits until the operator is past its settling
 * wait (coinPusherOperatorState).
 *
 * EARLIER BUILDS took a slot lease per machine (`slot-operator:<mid>`) and
 * don't read the room's. This build never writes those. While one is being
 * renewed, an earlier build is operating that machine and writing the same
 * `bal:` keys, so NO game here operates in the room until the record lapses;
 * a session that could operate then deletes it, so it never holds up a later
 * page. Every such record in the doc counts, found through an index
 * casinoDoc keeps, whatever machines the room's layout listed at the last
 * frame. RUN and the check before every write (stillOperates) read those
 * records afresh, so one that arrives between two frames counts at once,
 * even for a machine placed since. A read returns at most
 * LEGACY_SLOT_LEASE_READ_CAP of them, since any peer can write such keys.
 * While the doc holds more, one left unread may be live, so this build
 * operates nothing; a session that could operate deletes the lapsed ones it
 * read, a batch a term, until the rest fit.
 *
 * V0.38 ROOMS elected the two games separately, on `slot-operator` and
 * `pusher-operator`, each read by one game only, each with a device id of
 * its own, and the two could sit on two sessions of one deed holder: the very
 * two writers this lease removes. A v0.38 client reads only its own key and
 * takes a MISSING record at once, so this build does two things for as long
 * as such clients may share a room. HOLD-OFF: a live record under ANY of the
 * three keys that names another session holds this build off, under the
 * lapse and takeover maths above, one sighting memo per key. SHADOWS: on
 * every take and renewal the holder writes the same four-field record under
 * all three keys in ONE transaction (writeCasinoOperatorRecords), so a v0.38
 * slot election, its RUN button, its pusher election and its pusher panel
 * see a live foreign record where they look, and wait or read 'ready' as
 * they would for one of their own; a stop deletes every key naming this
 * session. Ownership needs every key this build writes to name this session
 * in this take: a shadow a v0.38 peer overwrote ends the take. The device
 * id is one per profile, seeded from and backfilled into the two old keys,
 * and both old ids are remembered as this device (loadDeviceIds).
 *
 *   Scenario                             Who holds       Why nobody else writes
 *   a1 OLD tab first, NEW joins          OLD, own keys   NEW sees a live foreign old-key record and holds
 *                                                        off; OLD ignores the primary; NEW waits for the
 *                                                        lapse (+60 s from another device).
 *   a2 NEW first, OLD joins              NEW             NEW's shadows name its session: OLD's slot
 *                                                        election, RUN and pusher election wait; OLD
 *                                                        panels read the pusher shadow and NEW settles
 *                                                        their requests unchanged.
 *   a3 Both take in one window           LWW per key     Both wait the settling wait; each sees the
 *                                                        other's record and ends its take, deleting only
 *                                                        records naming itself (the SPLITS caveat stays).
 *   a4 Same device, OLD tab hides        NEW after lapse NEW remembers both old device ids as this device
 *                                                        and honours the record's own expiry.
 *   a5 Same device, NEW tab hides        OLD after lapse NEW backfilled the old keys, so an OLD tab of
 *                                                        the profile is this device to NEW's shadows.
 *   b  Two installs of one deed holder   Either          Work binding unchanged (WHO THE RECORD NAMES);
 *                                                        a holder with no slot need starves the other
 *                                                        install's funded machines (a claim/yield rule
 *                                                        is a later step).
 *   c  Hidden operator tab               Successor       rAF-only ticks: no renewal, no release; the
 *                                                        record lapses (8 s same device, +60 s other);
 *                                                        on resume the tab's own clock ends its take and
 *                                                        paused work fails stillOperates. Both games
 *                                                        hand over at the same instant.
 *   d  Venture room, manual slot holder  The manual      Nobody may run the croupier, so nobody needs
 *                                        holder          the room for the pushers; the union of needs
 *                                                        keeps the lease with the slot holder.
 *   e  bfcache restore                   Whoever took    The pagehide listener deleted every record
 *                                        after pagehide  naming this session; on restore the tick holds
 *                                                        off or retakes with a new tenure.
 *
 * MIXED ROOMS, one regression to know: a v0.38 install holding
 * `pusher-operator` with no slot work holds a NEW install's funded slot
 * machines off for as long as it stays (in v0.38 the two keys let both
 * operate). Inherent in one writer: update the deed holder's installs
 * together.
 */
import {
  CASINO_OPERATOR_KEY,
  casinoDocEpoch,
  clearCasinoOperatorRecords,
  clearLegacySlotOperatorLease,
  COIN_PUSHER_OPERATOR_KEY,
  readLegacySlotOperatorLease,
  readLegacySlotOperatorMachineIds,
  readRoomOperatorLease,
  ROOM_OPERATOR_KEYS,
  writeCasinoOperatorRecords,
} from './casinoDoc';
import type { RoomOperatorKey, SlotOperatorLease } from './casinoDoc';
import { getPlayerId } from './identity';

export const OPERATOR_LEASE_MS = 8_000;
export const OPERATOR_LEASE_SETTLE_MS = 2_000;
export const OPERATOR_LEASE_RENEW_MS = 3_000;
/** How much longer than a lapse a session on another device waits before
 *  taking over (see SPLITS above). Both croupiers re-export it. */
export const OPERATOR_UNCLEAN_TAKEOVER_MS = 60_000;
/**
 * Write the two v0.38 room keys as shadows on every take and renewal (V0.38
 * ROOMS above). To retire, two releases after the shared lease shipped or
 * once v0.38 rooms are declared gone: flip to false, read the primary in
 * coinPusherOperatorState, drop COIN_PUSHER_OPERATOR_KEY from the pusher
 * panel's subscription, and move the tests that read this page's record
 * through the old readers to readCasinoOperatorLease. The hold-off reads
 * stay for good. Once this is false, a surviving v0.38 client finds its key
 * MISSING and takes it at once; the hold-off then ends this build's take
 * (`lost-foreign`) on the next frame, so one writer survives, but this build
 * is starved for as long as that client stays.
 */
export const WRITE_LEGACY_ROOM_SHADOWS = true;
/** The keys this build writes: all three while the shadows are on, else the
 *  primary only. Hold-off reads every key in ROOM_OPERATOR_KEYS regardless. */
const LEASE_KEYS: readonly RoomOperatorKey[] = WRITE_LEGACY_ROOM_SHADOWS
  ? ROOM_OPERATOR_KEYS
  : [CASINO_OPERATOR_KEY];

// ── Identity ─────────────────────────────────────────────────────────────────

const DEVICE_KEY = 'ssf-casino-operator-device';
/** The keys v0.38 kept a device id under, one per game: seeded from, in this
 *  order, and backfilled, so a v0.38 tab opened later on this profile mints
 *  nothing new (scenario a5). */
const LEGACY_DEVICE_KEYS = ['ssf-slot-operator-device', 'ssf-pusher-operator-device'] as const;
const DEVICE_ID = /^[0-9a-f-]{36}$/;

/** One id per browser profile (localStorage), shared by its tabs, and every
 *  id this profile's v0.38 tabs write under (knownDeviceIds). */
function loadDeviceIds(): { deviceId: string; knownDeviceIds: Set<string> } {
  const stored = new Map<string, string>();
  try {
    for (const key of [DEVICE_KEY, ...LEGACY_DEVICE_KEYS]) {
      const value = localStorage.getItem(key);
      if (value && DEVICE_ID.test(value)) stored.set(key, value);
    }
  } catch {
    const fresh = crypto.randomUUID(); // private mode: this page is its own device
    return { deviceId: fresh, knownDeviceIds: new Set([fresh]) };
  }
  const deviceId = stored.get(DEVICE_KEY)
    ?? stored.get(LEGACY_DEVICE_KEYS[0])
    ?? stored.get(LEGACY_DEVICE_KEYS[1])
    ?? crypto.randomUUID();
  try {
    for (const key of [DEVICE_KEY, ...LEGACY_DEVICE_KEYS]) {
      if (!stored.has(key)) localStorage.setItem(key, deviceId);
    }
  } catch { /* not kept: this page is its own device, as when nothing is stored */ }
  return { deviceId, knownDeviceIds: new Set([deviceId, ...stored.values()]) };
}

const { deviceId, knownDeviceIds } = loadDeviceIds();
/** `<device>:<page load>` — the lease record's sessionId. */
const operatorSessionId = `${deviceId}:${crypto.randomUUID()}`;

/** This page's operator session id (`<device>:<page load>`). */
export function casinoOperatorSession(): string {
  return operatorSessionId;
}

/** Whether a record was written by a session on this device (its tabs share
 *  the clock and the local node), under this build's device id or one of the
 *  v0.38 ids this profile kept. */
function isThisDevice(lease: SlotOperatorLease): boolean {
  for (const id of knownDeviceIds) {
    if (lease.sessionId.startsWith(`${id}:`)) return true;
  }
  return false;
}

// ── This session's take ──────────────────────────────────────────────────────

interface CasinoOperatorTake {
  docEpoch: number;
  playerId: string;
  /** This turn's token in the lease records, fresh for every take and kept
   *  across its renewals (SlotOperatorLease.tenure). */
  tenure: string;
  readyAt: number;
  renewedAt: number;
}

/** This session's turn as the room's operator, if it has one. */
let operator: CasinoOperatorTake | null = null;

/** The doc epoch of the room this session is leaving (leaveCasinoRoom):
 *  nothing there is operated or watched again, even while its last writes
 *  are being sent. The next room's doc has another epoch. */
let leavingDocEpoch: number | null = null;

export function isLeavingCasinoRoom(): boolean {
  return leavingDocEpoch === casinoDocEpoch();
}

// ── Watching the room's records ──────────────────────────────────────────────

/** A room record as this page saw it in this room's doc: when it first saw
 *  the current record (`at` — the holder rewrites its record at every
 *  renewal, so this is when this page last saw the lease renewed), and when
 *  it first saw the record's holder hold it in this tenure (`heldSince`). */
interface LeaseSighting {
  docEpoch: number;
  id: string;
  holder: string;
  at: number;
  heldSince: number;
}

/** The room's records as this page sees them, one per key, another session's
 *  only: this page's own records are never fed (they would reset the memo at
 *  every renewal). */
const seen = new Map<RoomOperatorKey, LeaseSighting>();

/** Earlier builds' per-machine leases as this page saw them in this room's
 *  doc (EARLIER BUILDS above), by machine: when it first saw each record. */
const earlierBuildLeasesSeen = new Map<string, { id: string; at: number }>();

/** Note a room record as this page sees it now. A new record by the same
 *  holder in the same tenure is a renewal: it keeps `heldSince`. A new
 *  tenure is a new take, with its own settling wait, even when this page
 *  never saw the lease go. */
function seeLease(key: RoomOperatorKey, lease: SlotOperatorLease, now: number): LeaseSighting {
  // Scoped to the bound doc: another room's same record starts afresh.
  const docEpoch = casinoDocEpoch();
  const holder = `${docEpoch}|${lease.playerId}|${lease.sessionId}|${lease.tenure ?? ''}`;
  const id = `${holder}|${lease.expiresAt}`;
  let sighting = seen.get(key);
  if (sighting?.id !== id) {
    sighting = {
      docEpoch,
      id,
      holder,
      at: now,
      heldSince: sighting?.holder === holder ? sighting.heldSince : now,
    };
    seen.set(key, sighting);
  }
  return sighting;
}

/** Every client watches the records' renewals, a frame at a time: that is
 *  how it tells a live operator from a lapsed one (CLOCKS above). A key with
 *  no record, or with this page's own, is forgotten: whoever takes it next
 *  starts its wait afresh. */
function observeRoomLeases(now: number): void {
  for (const key of ROOM_OPERATOR_KEYS) {
    const lease = readRoomOperatorLease(key);
    if (!lease || lease.sessionId === operatorSessionId) seen.delete(key);
    else seeLease(key, lease, now);
  }
}

/** Whether another session's room record is memoised in this room's doc: 1
 *  for a holder on three keys or on one (the croupiers' watch counts). */
export function casinoLeaseObserved(): 0 | 1 {
  const docEpoch = casinoDocEpoch();
  for (const sighting of seen.values()) {
    if (sighting.docEpoch === docEpoch) return 1;
  }
  return 0;
}

/**
 * When `lease` lapses as far as this page can tell, without comparing clocks
 * across devices (CLOCKS above): one OPERATOR_LEASE_MS after this page first
 * saw that exact record under `key` in this room's doc (what a previous
 * room's doc showed never counts). A tab on this device shares this clock, so
 * its own expiry counts too, though never past that.
 */
function leaseLapsesAt(key: RoomOperatorKey, lease: SlotOperatorLease, now: number): number {
  const heldUntil = seeLease(key, lease, now).at + OPERATOR_LEASE_MS;
  return isThisDevice(lease) ? Math.min(lease.expiresAt, heldUntil) : heldUntil;
}

/** Earliest time this session may take `lease` over: when it lapses, plus
 *  the split window when it is another device's (SPLITS). */
function takeoverAt(key: RoomOperatorKey, lease: SlotOperatorLease, now: number): number {
  const lapsesAt = leaseLapsesAt(key, lease, now);
  return isThisDevice(lease) ? lapsesAt : lapsesAt + OPERATOR_UNCLEAN_TAKEOVER_MS;
}

/** Whether another session may still be operating the room, by a live record
 *  under any of the three keys (V0.38 ROOMS): until then, this session
 *  neither takes the lease nor starts a machine. */
function heldElsewhere(now: number): boolean {
  for (const key of ROOM_OPERATOR_KEYS) {
    const lease = readRoomOperatorLease(key);
    if (lease && lease.sessionId !== operatorSessionId && now < takeoverAt(key, lease, now)) return true;
  }
  return false;
}

// ── Earlier builds ───────────────────────────────────────────────────────────

/**
 * Watch the earlier builds' per-machine leases in the room (EARLIER BUILDS),
 * and say whether one is operating a machine: a record this page saw written
 * or renewed within the last OPERATOR_LEASE_MS. A session that could operate
 * (`tidy`) deletes a lapsed one. Every lease the doc holds counts, found
 * through casinoDoc's index, whatever machines the room's layout listed at
 * the last frame: one for a machine placed since counts too. At most
 * LEGACY_SLOT_LEASE_READ_CAP are read; while the doc holds more, one of the
 * rest may be live, so this says one is operating.
 */
function watchEarlierBuilds(tidy: boolean, now: number): boolean {
  const docEpoch = casinoDocEpoch();
  const { machineIds, more } = readLegacySlotOperatorMachineIds();
  const read = new Set(machineIds);
  for (const machineId of [...earlierBuildLeasesSeen.keys()]) {
    if (!read.has(machineId)) earlierBuildLeasesSeen.delete(machineId);
  }
  let until = 0;
  for (const machineId of machineIds) {
    const lease = readLegacySlotOperatorLease(machineId);
    if (!lease) {
      earlierBuildLeasesSeen.delete(machineId);
      continue;
    }
    const id = `${docEpoch}|${lease.playerId}|${lease.sessionId}|${lease.expiresAt}`;
    let seen = earlierBuildLeasesSeen.get(machineId);
    if (seen?.id !== id) {
      seen = { id, at: now };
      earlierBuildLeasesSeen.set(machineId, seen);
    }
    const lapsesAt = seen.at + OPERATOR_LEASE_MS;
    if (now < lapsesAt) {
      until = Math.max(until, lapsesAt);
    } else if (tidy) {
      clearLegacySlotOperatorLease(machineId);
      earlierBuildLeasesSeen.delete(machineId);
    }
  }
  return more || now < until;
}

/** Whether an earlier build is operating a machine in this room now, read
 *  afresh from the doc, so a lease written or renewed since the last room
 *  tick counts, for any machine. Reads only: the room tick tidies lapsed
 *  records. */
export function isEarlierBuildOperatingNow(now: number): boolean {
  return watchEarlierBuilds(false, now);
}

/** A machine closed here (closeSlotMachine) is watched no more. */
export function forgetEarlierBuildLease(machineId: string): void {
  earlierBuildLeasesSeen.delete(machineId);
}

/** How many earlier builds' leases this page is watching: the croupiers'
 *  watch counts. */
export function earlierBuildLeasesWatched(): number {
  return earlierBuildLeasesSeen.size;
}

// ── The games ────────────────────────────────────────────────────────────────

export type OperatorGame = 'slots' | 'pusher' | 'air-hockey';

/** Why this page's take ended. `lost-own`: its record lapsed, went missing
 *  or was rewritten with another take while no other session's record was
 *  there (the slot side keeps its machines run by hand; the next frame takes
 *  the lease afresh). `lost-foreign`: another session's record was there.
 *  `legacy`: an earlier build is operating. `released`: no game needed the
 *  room, or the page released it. `leaving`: leaveCasinoRoom. `yielded`: the
 *  holder stepped aside for a claimant (a later step). */
export type OperatorStopReason = 'lost-own' | 'lost-foreign' | 'legacy' | 'released' | 'leaving' | 'yielded';

export interface OperatorGameHooks {
  /** This page's take has ended, whichever call ended it: state stamped
   *  with it is dead. */
  onStop(reason: OperatorStopReason): void;
  /** leaveCasinoRoom: forget everything queued or watched in the room. */
  onLeave(): void;
}

const hooks = new Map<OperatorGame, OperatorGameHooks>();
/** Each game's need for the room, as its tick last reported it, in the doc
 *  it reported it for: a need of another doc is none. */
const needs = new Map<OperatorGame, { docEpoch: number; need: boolean }>();

export function registerOperatorGame(game: OperatorGame, gameHooks: OperatorGameHooks): void {
  hooks.set(game, gameHooks);
}

/** A game's tick reports whether it needs the room this frame; its stop is
 *  reporting false. Nothing else a game does touches a record. */
export function reportOperatorNeed(game: OperatorGame, need: boolean): void {
  needs.set(game, { docEpoch: casinoDocEpoch(), need });
}

function unionNeed(docEpoch: number): boolean {
  for (const entry of needs.values()) {
    if (entry.docEpoch === docEpoch && entry.need) return true;
  }
  return false;
}

function notifyStop(reason: OperatorStopReason): void {
  for (const game of hooks.values()) game.onStop(reason);
}

// ── Ownership ────────────────────────────────────────────────────────────────

/** This page's take, if it has one in this room's doc. */
export interface CasinoTake {
  docEpoch: number;
  playerId: string;
  tenure: string;
  readyAt: number;
}

export function currentTake(): CasinoTake | null {
  if (!operator || operator.docEpoch !== casinoDocEpoch()) return null;
  const { docEpoch, playerId, tenure, readyAt } = operator;
  return { docEpoch, playerId, tenure, readyAt };
}

/** True while this session is the room's operator and holds a live lease in
 *  its current take under EVERY key it writes, read afresh: a record naming
 *  this page with another take, a shadow a peer overwrote, or a missing one
 *  is not this page's lease. */
export function ownsCasinoOperatorLease(playerId: string, now = Date.now()): boolean {
  if (!operator || operator.docEpoch !== casinoDocEpoch() || operator.playerId !== playerId) return false;
  for (const key of LEASE_KEYS) {
    const lease = readRoomOperatorLease(key);
    if (lease?.playerId !== playerId
      || lease.sessionId !== operatorSessionId
      || lease.tenure !== operator.tenure
      || lease.expiresAt <= now) return false;
  }
  return true;
}

/**
 * THE check before every write under the lease. Whether this session still
 * operates the room in the same take of the lease (`tenure`) as when a piece
 * of work began, in the doc of `docEpoch`. A round's accept, settle and
 * refunds check it after their awaits, just before they write, and the
 * pusher before each pass and drain: a session that has let the lease go (a
 * room it is leaving, a page put away in the back/forward cache, a lease lost
 * or lapsed) never writes behind whoever took over, and work begun under one
 * take never writes under a later one, which may still be in its settling
 * wait. The earlier builds' leases are read afresh too, so a renewal that
 * arrived while the work was paused stops it before the next frame does
 * (EARLIER BUILDS). The work stays for the room's next operator.
 */
export function stillOperates(docEpoch: number, tenure: string, now = Date.now()): boolean {
  return operator !== null
    && operator.docEpoch === docEpoch
    && docEpoch === casinoDocEpoch()
    && operator.tenure === tenure
    && ownsCasinoOperatorLease(operator.playerId, now)
    && !isEarlierBuildOperatingNow(now);
}

/** Whether this session operates the room and is past its settling wait: a
 *  drain made outside the tick (closeCoinPusher) asks this. */
export function operatorReady(now = Date.now()): boolean {
  const take = currentTake();
  return take !== null && now >= take.readyAt && stillOperates(take.docEpoch, take.tenure, now);
}

// ── Take, renew, end ─────────────────────────────────────────────────────────

/** Take the room: a fresh tenure, the records under every key this build
 *  writes in one transaction, and a settling wait. Over a take this page
 *  still counts as its own (RUN over a record naming this page with another
 *  take), that take ends first. */
function take(playerId: string, now: number): void {
  const docEpoch = casinoDocEpoch();
  if (operator) {
    const ended = operator.docEpoch === docEpoch; // a take of another doc is void, not a lease
    operator = null;
    if (ended) notifyStop('lost-own');
  }
  const tenure = crypto.randomUUID();
  writeCasinoOperatorRecords({
    playerId,
    sessionId: operatorSessionId,
    tenure,
    expiresAt: now + OPERATOR_LEASE_MS,
  }, LEASE_KEYS);
  operator = {
    docEpoch,
    playerId,
    tenure,
    readyAt: now + OPERATOR_LEASE_SETTLE_MS,
    renewedAt: now,
  };
}

function renew(own: CasinoOperatorTake, now: number): void {
  writeCasinoOperatorRecords({
    playerId: own.playerId,
    sessionId: operatorSessionId,
    tenure: own.tenure,
    expiresAt: now + OPERATOR_LEASE_MS,
  }, LEASE_KEYS);
  own.renewedAt = now;
}

/** End this page's take: every room record naming this session goes,
 *  whatever its tenure, so a successor needn't wait it out, and every game
 *  hears why. The ONLY function that deletes a room record. */
function endTake(reason: OperatorStopReason): void {
  operator = null;
  clearCasinoOperatorRecords(operatorSessionId, ROOM_OPERATOR_KEYS);
  notifyStop(reason);
}

// ── The election ─────────────────────────────────────────────────────────────

export type ElectionOutcome =
  | { kind: 'leaving' }
  /** No game needs the room: released, or not taken. */
  | { kind: 'idle' }
  /** An earlier build's `slot-operator:<mid>` is live. */
  | { kind: 'legacy-build' }
  /** A live record of another session under any key. */
  | { kind: 'held-elsewhere' }
  /** This call ended the take; `foreignHolder` says whether another
   *  session's record was there. */
  | { kind: 'lost'; foreignHolder: boolean }
  | { kind: 'starting'; playerId: string; tenure: string }
  | { kind: 'ready'; docEpoch: number; playerId: string; tenure: string };

/**
 * The room's election (ELECTION above), run by every game's tick, every
 * frame, on every client. Observe the three keys, watch the earlier builds
 * (tidying lapsed leases when `tidyLegacy`: the caller may operate), then
 * take, renew, end or keep this page's take from the games' stored needs.
 * Idempotent by state: safe twice a frame. Within one call a loss never
 * retakes (the next call may, with a fresh tenure and settling wait).
 */
export function electCasinoOperator(now: number, tidyLegacy: boolean): ElectionOutcome {
  if (isLeavingCasinoRoom()) return { kind: 'leaving' };
  const docEpoch = casinoDocEpoch();
  const playerId = getPlayerId();
  observeRoomLeases(now);
  const legacyLive = watchEarlierBuilds(tidyLegacy, now);
  const own = operator !== null && operator.docEpoch === docEpoch && operator.playerId === playerId
    ? operator
    : null;
  operator = own; // a take of another doc or player is void, not a lease
  if (legacyLive) {
    // An earlier build is operating a machine here: it doesn't read these
    // records, so any work here could settle alongside it (EARLIER BUILDS).
    if (own) endTake('legacy');
    return { kind: 'legacy-build' };
  }
  if (own) {
    if (!ownsCasinoOperatorLease(playerId, now)) {
      // Lost, lapsed (a tab that got no frames for a while), or rewritten
      // with another take (by a peer, or an old record of this page's own
      // written back): this take is over. Every record naming this session
      // goes now, and the next call takes the lease afresh, settling wait
      // and all, if nobody else has.
      const foreignHolder = ROOM_OPERATOR_KEYS.some((key) => {
        const lease = readRoomOperatorLease(key);
        return lease !== null && lease.sessionId !== operatorSessionId;
      });
      endTake(foreignHolder ? 'lost-foreign' : 'lost-own');
      return { kind: 'lost', foreignHolder };
    }
    if (!unionNeed(docEpoch)) {
      // No game needs the room: let the lease go, so another session's
      // machines needn't wait it out.
      endTake('released');
      return { kind: 'idle' };
    }
    if (now - own.renewedAt >= OPERATOR_LEASE_RENEW_MS) renew(own, now);
    return now < own.readyAt
      ? { kind: 'starting', playerId, tenure: own.tenure }
      : { kind: 'ready', docEpoch, playerId, tenure: own.tenure };
  }
  if (!unionNeed(docEpoch)) return { kind: 'idle' };
  if (heldElsewhere(now)) return { kind: 'held-elsewhere' };
  take(playerId, now);
  return { kind: 'starting', playerId, tenure: operator!.tenure };
}

/**
 * The RUN path (a machine started by hand from its service panel): refuses
 * while this session is leaving the room, while an earlier build is
 * operating (read afresh), or while any key is held elsewhere; otherwise
 * records the game's need — so the next election, by another game's tick,
 * keeps the lease — and takes the room at once unless this page already
 * holds it in its current take. A record naming this page with another
 * take is not held: it is overwritten, with a fresh tenure.
 */
export function takeCasinoOperatorLease(game: OperatorGame, playerId: string, now: number): boolean {
  if (isLeavingCasinoRoom()) return false;
  observeRoomLeases(now);
  if (watchEarlierBuilds(false, now)) return false;
  if (heldElsewhere(now)) return false;
  reportOperatorNeed(game, true);
  if (!ownsCasinoOperatorLease(playerId, now)) take(playerId, now);
  return true;
}

// ── Panel states ─────────────────────────────────────────────────────────────

/** The room's operator as this page can tell it: none with a live lease
 *  (`offline`), one still in its OPERATOR_LEASE_SETTLE_MS wait after taking
 *  the lease (`starting` — a drop made now would reach it too late to keep
 *  its timing), or one at work (`ready`). */
export type CasinoOperatorState = 'offline' | 'starting' | 'ready';

/**
 * The operator state by one key: this session by its own take and wait, any
 * other while its record hasn't lapsed by leaseLapsesAt, ready
 * OPERATOR_LEASE_SETTLE_MS after this page first saw its holder take it —
 * never sooner than the holder itself, which waits that long from its own
 * write. Renewals don't restart the wait; a new take does (its record
 * carries a new tenure), even one this page saw no gap before. Read afresh
 * and never frame-stamped: a panel's poll notices a lapse with no key
 * change, and a foreign record it is the first to see goes into the memo.
 */
function stateForKey(key: RoomOperatorKey, now: number): CasinoOperatorState {
  if (isLeavingCasinoRoom()) return 'offline';
  const lease = readRoomOperatorLease(key);
  if (!lease) return 'offline';
  if (lease.sessionId === operatorSessionId) {
    if (!operator || operator.docEpoch !== casinoDocEpoch()
      || lease.tenure !== operator.tenure || lease.expiresAt <= now) return 'offline';
    return now < operator.readyAt ? 'starting' : 'ready';
  }
  if (now >= leaseLapsesAt(key, lease, now)) return 'offline';
  return now < seeLease(key, lease, now).heldSince + OPERATOR_LEASE_SETTLE_MS ? 'starting' : 'ready';
}

/** By the primary key: only this build's holders write it. */
export function casinoOperatorState(now = Date.now()): CasinoOperatorState {
  return stateForKey(CASINO_OPERATOR_KEY, now);
}

/** By the v0.38 pusher key, which this build's holders shadow and v0.38
 *  holders write, so a player's DROP panel reads either. (Reads the primary
 *  once WRITE_LEGACY_ROOM_SHADOWS is retired.) */
export function coinPusherOperatorState(now = Date.now()): CasinoOperatorState {
  return stateForKey(COIN_PUSHER_OPERATOR_KEY, now);
}

// ── Release and leave ────────────────────────────────────────────────────────

/** Stop operating here and release the room's records if this session holds
 *  them, so another tab or device needn't wait them out. Work still settling
 *  here writes nothing more (stillOperates), even on a page restored from
 *  the back/forward cache: whoever takes over finds it. */
export function releaseCasinoOperatorLease(): void {
  // Unconditional, held or not: the games' stop hooks run on every release
  // (the slot side forgets its machines run by hand, as its release did).
  endTake('released');
}

/**
 * Leaving the room (main.ts leaveRoom, while the room's doc is still bound):
 * release the records if this session holds them, and operate or watch
 * nothing more in this room, so no frame takes the lease back while the
 * release is being sent. The room's sightings, the earlier builds', the
 * games' needs and whatever each game queued or watched go with it. The next
 * room's doc lifts this by its own epoch. Idempotent: a second call finds
 * nothing held and empty maps.
 */
export function leaveCasinoRoom(): void {
  leavingDocEpoch = casinoDocEpoch();
  endTake('leaving');
  seen.clear();
  earlierBuildLeasesSeen.clear();
  needs.clear();
  for (const game of hooks.values()) game.onLeave();
}

// Best effort on page close: the write may not flush. (A page restored from
// the back/forward cache simply takes the lease again.) The page's ONE such
// listener: the games register none.
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseCasinoOperatorLease);
