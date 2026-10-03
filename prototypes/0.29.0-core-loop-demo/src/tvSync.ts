/**
 * 📺 tvSync — the loop that keeps ONE player in step with the room's TV
 * record (tvDoc.ts), for the holder and for every viewer alike.
 *
 * DOM-free on purpose: the player is an adapter (tvTheatre.ts wraps a
 * YouTube iframe, an HTML <video> and the archive.org embed), the clock is
 * injected, and the record is read through tvDoc, so the whole thing runs
 * under vitest against a fake player and a fake clock.
 *
 * Two roles, two rules (plan §3.1):
 *
 *  - A VIEWER follows the record. readPlayback anchors the holder's last
 *    sample to THIS page's receipt time; a player further than
 *    TV_SEEK_OVER_MS from that SEEKS, one within the band but past
 *    TV_NUDGE_OVER_MS runs ±3 % faster or slower when it can (an HTML
 *    <video>), and a player with coarse rate steps (YouTube) only ever seeks.
 *  - The HOLDER is the record. It follows an explicit transport write (PLAY
 *    NOW, a seek, a resume — tvDoc's `jump` revision) exactly once, and
 *    otherwise is never corrected by the record's own extrapolation of its
 *    heartbeats: a holder whose player buffers publishes the stalled
 *    position, and the room follows IT. Every TV_HEARTBEAT_MS it writes its
 *    own player's position — once any transport jump has landed, never the
 *    position a jump is still leaving behind — and the scheduled
 *    countdown's T0 is the holder's first heartbeat after it.
 */

import {
  driftAction, iHoldRemote, readPlayback, readTv, tvHeartbeat, tvStop,
  TV_HEARTBEAT_MS, TV_NUDGE_RATE, TV_SEEK_OVER_MS,
} from './tvDoc';
import type { PlaybackNow } from './tvDoc';

/** What the controller needs from a player. Positions in ms. */
export interface TvPlayer {
  /** Fine playback-rate steps (an HTML <video>); false for YouTube. */
  readonly canNudge: boolean;
  /** Can jump to a position; false for the archive.org embed (start only). */
  readonly canSeek: boolean;
  /** Reports a real position. False for the archive.org embed, whose
   *  currentMs() is always 0: such a player is never the room's clock — the
   *  holder's headless heartbeat (tvSession) keeps it instead. */
  readonly hasClock: boolean;
  /** Media is loaded enough to play/seek. Nothing is applied before this. */
  isReady(): boolean;
  isPlaying(): boolean;
  /** The media ran to its end. A play() on an ended <video> starts it over,
   *  so the controller never calls play() here: the holder ends the
   *  programme, a viewer waits for the record to move on. */
  isEnded(): boolean;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  currentMs(): number;
  /** The media's length in ms when the player knows it, else NaN (a live
   *  stream, the archive embed, YouTube before its metadata arrives). */
  durationMs(): number;
  setRate(rate: number): void;
  setVolume(volume: number): void;
}

/** A position past the media's end is the end, when the length is known:
 *  a player clamps such a seek there, so the target must agree with it or
 *  it would never be reached. */
function clampToEnd(ms: number, durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.min(ms, durationMs) : ms;
}

export interface TvSyncDeps {
  itemId: string;
  player: TvPlayer;
  now?: () => number;
  /** Measured round trip to the hub, if known (NetworkProvider.stats). */
  rttMs?: () => number;
  /** Seams, defaulting to tvDoc's live functions. */
  iHold?: () => boolean;
  playback?: (now: number, rttMs: number) => PlaybackNow;
  /** The record's programme-action revision (tvDoc `jump`). */
  jump?: () => number;
  heartbeat?: (positionMs: number) => void;
  volume?: () => number;
  /** The holder's player reached the end: the programme is over. Default:
   *  tvStop — back to the home screen, the film kept in history. */
  onEnded?: () => void;
}

/** After a seek, leave a VIEWER's player alone for this long: a seek that is
 *  still buffering reads as "far behind" and would be seeked again every
 *  tick. (The holder seeks only on a transport write, at once.) */
export const TV_SEEK_COOLDOWN_MS = 2_000;

export class TvSyncController {
  private readonly now: () => number;
  private readonly rttMs: () => number;
  private readonly iHold: () => boolean;
  private readonly playback: (now: number, rttMs: number) => PlaybackNow;
  private readonly jump: () => number;
  private readonly heartbeat: (positionMs: number) => void;
  private readonly volume: () => number;
  private readonly onEnded: () => void;
  private endedHandled = false;
  private lastBeatAt = -Infinity;
  private lastSeekAt = -Infinity;
  private appliedVolume = -1;
  private rate = 1;
  /** The scheduled countdown parks the player at 0 once, not every tick. */
  private parked = false;
  /** The holder: the transport revision it has followed, and the position a
   *  jump is still carrying the player to (null once landed; never past the
   *  media's end once the player has said how long it is). */
  private appliedJump: number | null = null;
  private pendingTarget: number | null = null;

  constructor(private readonly deps: TvSyncDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.rttMs = deps.rttMs ?? (() => 0);
    this.iHold = deps.iHold ?? (() => iHoldRemote(deps.itemId));
    this.playback = deps.playback ?? ((now, rtt) => readPlayback(deps.itemId, now, rtt));
    this.jump = deps.jump ?? (() => readTv(deps.itemId).jump);
    this.heartbeat = deps.heartbeat ?? ((p) => { tvHeartbeat(deps.itemId, p); });
    this.volume = deps.volume ?? (() => readTv(deps.itemId).volume);
    this.onEnded = deps.onEnded ?? (() => { tvStop(deps.itemId); });
  }

  /** The transit lead for this page: half the round trip for a viewer, none
   *  for the holder, whose own writes land here without crossing a wire. */
  private lead(): number {
    return this.iHold() ? 0 : this.rttMs();
  }

  /** The room's playback as of this tick (what the UI shows). */
  current(): PlaybackNow {
    return this.playback(this.now(), this.lead());
  }

  /** Drive every ~250–500 ms. Idempotent: a tick with nothing to change
   *  touches nothing. */
  tick(): PlaybackNow {
    const now = this.now();
    const hold = this.iHold();
    const pb = this.playback(now, this.lead());
    const p = this.deps.player;
    if (!p.isReady()) return pb;
    // The set's volume, applied once the player can take it: a YouTube
    // player swallows a setVolume before onReady, and caching it then would
    // leave the room's setting unapplied for good.
    const vol = this.volume();
    if (vol !== this.appliedVolume) {
      p.setVolume(vol);
      this.appliedVolume = vol;
    }

    if (pb.state === 'playing') {
      this.parked = false;
      if (hold) return this.tickHolder(p, pb, now);
      return this.tickViewer(p, pb, now);
    }

    // Not playing: whatever transport revision brought us here is followed
    // by the state itself; a later resume is a new revision to follow.
    this.appliedJump = this.jump();
    this.pendingTarget = null;

    if (pb.state === 'paused') {
      if (p.isPlaying()) p.pause();
      this.setRate(1);
      if (p.canSeek && Math.abs(p.currentMs() - pb.positionMs) > TV_SEEK_OVER_MS
        && now - this.lastSeekAt >= TV_SEEK_COOLDOWN_MS) {
        p.seek(pb.positionMs);
        this.lastSeekAt = now;
      }
      return pb;
    }

    if (pb.state === 'scheduled') {
      if (p.isPlaying()) p.pause();
      if (!this.parked && p.canSeek) {
        p.seek(0);
        this.parked = true;
      }
      return pb;
    }

    // 'home' / 'off': nothing on.
    if (p.isPlaying()) p.pause();
    this.setRate(1);
    return pb;
  }

  /** The holder: follow a transport write once, publish the player's own
   *  position otherwise, end the programme when the player ends. */
  private tickHolder(p: TvPlayer, pb: PlaybackNow, now: number): PlaybackNow {
    const jump = this.jump();
    if (jump !== this.appliedJump) {
      // PLAY NOW, a remote seek, a resume: go where the write says, now
      // (no cooldown — this is the one time the record drives the holder).
      // Within the seek band nothing moves: a player that is already there
      // (PLAY NOW from the top, a resume where it paused) stays put.
      this.appliedJump = jump;
      this.endedHandled = false;
      // A target past the end (+10 s with five left) is the end: the player
      // clamps the seek there, and so must the target, or it would never be
      // reached and the programme never closed.
      const target = clampToEnd(pb.positionMs, p.durationMs());
      if (p.canSeek && Math.abs(p.currentMs() - target) > TV_SEEK_OVER_MS) {
        p.seek(target);
        this.lastSeekAt = now;
        this.pendingTarget = target;
      }
    }
    // A jump has landed once the player reads within the band of it — checked
    // every tick, not only when a beat is due, so a player that then runs to
    // its end (a replay of a short film) is seen to end, and so the next beat
    // goes out as soon as it may. Clamped again here, with a length the
    // player may not have known at the jump; and a FORWARD seek that ended
    // the player has landed wherever the media stops, whether or not it ever
    // said how long it was — a backward one from the end has not.
    if (this.pendingTarget !== null) {
      const target = clampToEnd(this.pendingTarget, p.durationMs());
      const at = p.currentMs();
      const landed = Math.abs(at - target) <= TV_SEEK_OVER_MS
        || (p.isEnded() && target >= at - TV_SEEK_OVER_MS);
      if (landed) this.pendingTarget = null;
    }
    this.setRate(1);
    if (p.isEnded()) {
      // A seek that un-ends the player may still be landing (YouTube's is
      // asynchronous): wait for it. Otherwise the programme is over, once.
      if (this.pendingTarget === null && !this.endedHandled) {
        this.endedHandled = true;
        this.onEnded();
      }
      return pb;
    }
    this.endedHandled = false;
    if (!p.isPlaying()) p.play();
    // The heartbeat: the player's own position, from a player that HAS a
    // clock (the archive embed reports nothing; the headless beat keeps the
    // room's clock for it), and never the position a jump is still leaving
    // behind — publishing that would undo the very jump that was asked for.
    if (p.hasClock && this.pendingTarget === null && now - this.lastBeatAt >= TV_HEARTBEAT_MS) {
      this.heartbeat(p.currentMs());
      this.lastBeatAt = now;
    }
    return pb;
  }

  /** A viewer: converge on the record (seek when far, nudge when near). */
  private tickViewer(p: TvPlayer, pb: PlaybackNow, now: number): PlaybackNow {
    if (p.isEnded()) {
      // A player at its end is never play()ed as it stands (it would start
      // over). A record well BEFORE the end is a rewind or a replay: seek
      // there — which un-ends the player — and go. Otherwise hold until the
      // record moves on (the holder ends the programme).
      if (p.canSeek && pb.positionMs < p.currentMs() - TV_SEEK_OVER_MS) {
        p.seek(pb.positionMs);
        this.lastSeekAt = now;
        this.setRate(1);
        p.play();
      }
      return pb;
    }
    if (!p.isPlaying()) p.play();
    const action = driftAction(p.currentMs(), pb.positionMs, p.canNudge);
    if (action === 'seek') {
      if (p.canSeek && now - this.lastSeekAt >= TV_SEEK_COOLDOWN_MS) {
        p.seek(clampToEnd(pb.positionMs, p.durationMs()));
        this.lastSeekAt = now;
        this.setRate(1);
      }
    } else if (action === 'speed-up') {
      this.setRate(1 + TV_NUDGE_RATE);
    } else if (action === 'slow-down') {
      this.setRate(1 - TV_NUDGE_RATE);
    } else {
      this.setRate(1);
    }
    return pb;
  }

  private setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    this.deps.player.setRate(rate);
  }
}
