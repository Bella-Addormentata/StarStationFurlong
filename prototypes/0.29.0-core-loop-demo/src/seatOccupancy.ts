/**
 * 🪑 One person per seat.
 *
 * Nothing used to stop two players being routed into the same chair: a click
 * picked a seat from the furniture and the avatar walked to it whether or not
 * someone was already in it, so two foxes could sit inside one another on a
 * stool, a bunk or a hot-tub spot.
 *
 * Who is sitting where already travels: the 13-byte movement tick carries a
 * "seated" flag (bit1) from the first frame of the sit-down slide, and while
 * seated its x/z is the avatar root — the seat's sit point once settled — and
 * its yaw is the seat's faceAngle. Every client builds the same SEATS list
 * from the same synced furniture doc, so each one can say which seat a peer is
 * in without any new wire traffic. That is all this module does, plus the two
 * decisions built on it: which seat a click should go to, and who keeps a seat
 * when two players sat down in it at the same moment.
 *
 * Pure (no DOM, no three.js; `Seat` is a type-only import) so it is provable
 * in the Node test environment.
 */

import type { Seat } from './seats';

/** The tick fields that place a seated peer. */
export interface SeatedPeer {
  x: number;
  z: number;
  /** Tick yaw — the seat's faceAngle while seated, wrapped into [0, 2π). */
  facing: number;
  /** Tick flags bit3 — on the upper of two stacked seats (top bunk). */
  elevated: boolean;
}

/** How close a peer's root must be to a sit point (or to the slide onto it)
 *  to count as on that seat — the radius world.ts already matches peers with. */
const SIT_MATCH_R = 0.35;
/** The u16 yaw on the wire resolves 2π/65536 ≈ 1e-4 rad. */
const FACING_EPS = 1e-3;
/** Two slides closer than this to the peer cannot say which one it is on. */
const SLIDE_AMBIGUITY = 0.1;

/** Open water is not a seat anyone can take: a pool's "swim" seats are spots
 *  to wade in from, and any number of swimmers share the water. */
const isClaimable = (seat: Seat): boolean => !seat.swim;

const angleGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};

/** Distance from (x, z) to the segment a → b. */
const segmentDist = (
  x: number,
  z: number,
  a: { x: number; z: number },
  b: { x: number; z: number },
): number => {
  const ax = b.x - a.x;
  const az = b.z - a.z;
  const len2 = ax * ax + az * az;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ax + (z - a.z) * az) / len2)) : 0;
  return Math.hypot(x - (a.x + ax * t), z - (a.z + az * t));
};

/** Where the sit-down slide onto `seat` starts: the bridge crest for a seat
 *  reached over a scripted path, the front point for everything else. */
const slideStart = (seat: Seat): { x: number; z: number } =>
  seat.path && seat.path.length > 0 ? seat.path[seat.path.length - 1] : seat.front;

/** Of several seats at one spot, the one on the peer's level: the two bunk
 *  berths share a sit point and differ only in height, and the `elevated` bit
 *  exists to tell them apart (the same rule world.ts uses for the peer's y). */
const onPeerLevel = (seats: Seat[], elevated: boolean): Seat =>
  seats.find((s) => s.sitY > 0.8 === elevated) ?? seats[0];

/**
 * The seat a seated peer is on, or is sliding onto; null when none fits.
 *
 * Two passes. A settled peer sits on its seat's sit point, which is the
 * match. A peer still sliding in is somewhere between the slide's start and
 * the sit point: it counts too, because the seated flag is up from the slide's
 * first frame, and a claim has to be visible as early as the sender makes it
 * or two players can each see an empty seat for the length of the slide. The
 * slide is told apart from a neighbouring seat's by the facing, which the
 * tick carries exactly.
 */
export function seatClaimedBy(seats: readonly Seat[], peer: SeatedPeer): Seat | null {
  const claimable = seats.filter(isClaimable);
  const settled = claimable.filter(
    (s) => Math.hypot(s.sit.x - peer.x, s.sit.z - peer.z) < SIT_MATCH_R,
  );
  if (settled.length > 0) return onPeerLevel(settled, peer.elevated);

  const sliding = claimable
    .filter((s) => angleGap(s.faceAngle, peer.facing) <= FACING_EPS)
    .map((s) => ({ s, d: segmentDist(peer.x, peer.z, slideStart(s), s.sit) }))
    .filter((c) => c.d < SIT_MATCH_R)
    .sort((a, b) => a.d - b.d);
  if (sliding.length === 0) return null;
  const nearest = sliding[0];
  const samePlace = (s: Seat) =>
    Math.hypot(s.sit.x - nearest.s.sit.x, s.sit.z - nearest.s.sit.z) < 1e-6;
  // Two seats facing the same way whose slides start from one point (a front
  // the walkable fallback shared between neighbours) cannot be told apart
  // until the slides part. Name neither until they do: a wrong guess would
  // read as a clash with whoever is in the other seat.
  if (sliding.some((c) => !samePlace(c.s) && c.d - nearest.d < SLIDE_AMBIGUITY)) {
    return null;
  }
  return onPeerLevel(
    sliding.filter((c) => samePlace(c.s)).map((c) => c.s),
    peer.elevated,
  );
}

/** Seat ids are `${itemId}:${templateIndex}`. */
const itemOf = (seatId: string): string => seatId.slice(0, seatId.lastIndexOf(':'));

/**
 * The seat a player asking for `wanted` should be sent to: `wanted` itself
 * when nobody else has it, otherwise the nearest free spot of the same kind
 * on the same piece of furniture (the next sofa cushion, another quarter of
 * the hot tub, the other bunk), otherwise null — the piece is full.
 *
 * "The same kind" keeps a full dive board from becoming a seat on the bench
 * that shares its pool item: only seats that lie / dive alike stand in for
 * each other.
 */
export function freeSeatFor(
  seats: readonly Seat[],
  wanted: Seat,
  taken: ReadonlySet<string>,
): Seat | null {
  if (!isClaimable(wanted) || !taken.has(wanted.id)) return wanted;
  const item = itemOf(wanted.id);
  let best: Seat | null = null;
  let bestDist = Infinity;
  for (const seat of seats) {
    if (
      seat.id === wanted.id ||
      !isClaimable(seat) ||
      taken.has(seat.id) ||
      itemOf(seat.id) !== item ||
      seat.lie !== wanted.lie ||
      seat.dive !== wanted.dive
    ) {
      continue;
    }
    const d = Math.hypot(seat.sit.x - wanted.sit.x, seat.sit.z - wanted.sit.z);
    if (d < bestDist) {
      best = seat;
      bestDist = d;
    }
  }
  return best;
}

/** A claim this much older than the other is plainly first. */
const KEEP_FIRST_MS = 1000;
/** A claim this much younger than the other is plainly second. Smaller than
 *  KEEP_FIRST_MS by twice the one-way delay this assumes (≤ 250 ms, tick
 *  interval included) — see keepsSeat. */
const YIELD_FIRST_MS = 500;
/** Tick counters closer than this (1 s at 20 Hz) cannot rank two players. */
const SEQ_MARGIN = 20;

/** Both sides of a seat clash, each measured on THIS client. */
export interface SeatClash {
  /** When the local player's claim on the seat began (ms, local clock). */
  mineSince: number;
  /** When the peer's claim on the same seat was first seen (ms, local clock). */
  theirsSince: number;
  /** The local player's movement-tick counter (u16, wraps). */
  mySeq: number;
  /** The peer's latest movement-tick counter (u16, wraps). */
  theirSeq: number;
}

/**
 * Two players are in one seat — does the LOCAL one keep it?
 *
 * The click and the last step before sitting both refuse a taken seat, so
 * this only decides the case those checks cannot see: two players who sat
 * down within one network delay of each other, or a peer whose game sat
 * someone down on top of a player it never saw. Both games run this with the
 * roles swapped, and it is built so that they never BOTH keep the seat:
 *
 *  1. Whoever's claim is plainly older keeps it. A sees B's claim arrive one
 *     delay after B made it, and B sees A's the same way, so the two clients'
 *     `theirsSince − mineSince` always sum to the round trip. Keeping above
 *     +1000 ms and yielding below −500 ms therefore agree as long as each
 *     delay is under 250 ms.
 *  2. Otherwise the tick counters decide, and they agree for the same reason:
 *     each side compares its own counter with the other's last one, so the
 *     two differences sum to the counters' combined lag, which is far less
 *     than twice SEQ_MARGIN. The difference is read as a signed 16-bit value,
 *     which keeps the two readings consistent across the counter's wrap.
 *  3. Counters too close to rank: both yield. Two players who started their
 *     games within a second of each other AND sat in one seat within a
 *     network delay of each other both stand up, and either can sit again.
 */
export function keepsSeat(clash: SeatClash): boolean {
  const lead = clash.theirsSince - clash.mineSince;
  if (lead > KEEP_FIRST_MS) return true;
  if (lead < -YIELD_FIRST_MS) return false;
  let d = (clash.mySeq - clash.theirSeq) & 0xffff;
  if (d >= 0x8000) d -= 0x10000;
  return d > SEQ_MARGIN;
}
