/**
 * 📺 tvSync — the loop that keeps ONE player in step with the room's TV
 * record (tvDoc.ts), for the holder and for every viewer alike.
 *
 * DOM-free on purpose: the player is an adapter (tvTheatre.ts wraps a
 * YouTube iframe, an HTML <video> and the archive.org embed), the clock is
 * injected, and the record is read through tvDoc, so the whole thing runs
 * under vitest against a fake player and a fake clock.
 *
 * The rule it applies (plan §3.1): the record says where the room is
 * (readPlayback anchors the holder's last sample to THIS page's receipt
 * time); a player that is further than TV_SEEK_OVER_MS from that SEEKS, one
 * within the band but past TV_NUDGE_OVER_MS runs ±3 % faster or slower when
 * it can (an HTML <video>), and a player with coarse rate steps (YouTube)
 * only ever seeks. The holder is the room's clock: every TV_HEARTBEAT_MS it
 * writes its own player's position, so viewers converge on IT, and the
 * scheduled countdown's T0 is the holder's first heartbeat after it.
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
  setRate(rate: number): void;
  setVolume(volume: number): void;
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
  heartbeat?: (positionMs: number) => void;
  volume?: () => number;
  /** The holder's player reached the end: the programme is over. Default:
   *  tvStop — back to the home screen, the film kept in history. */
  onEnded?: () => void;
}

/** After a seek, leave the player alone for this long: a seek that is still
 *  buffering reads as "far behind" and would be seeked again every tick. */
export const TV_SEEK_COOLDOWN_MS = 2_000;

export class TvSyncController {
  private readonly now: () => number;
  private readonly rttMs: () => number;
  private readonly iHold: () => boolean;
  private readonly playback: (now: number, rttMs: number) => PlaybackNow;
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

  constructor(private readonly deps: TvSyncDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.rttMs = deps.rttMs ?? (() => 0);
    this.iHold = deps.iHold ?? (() => iHoldRemote(deps.itemId));
    this.playback = deps.playback ?? ((now, rtt) => readPlayback(deps.itemId, now, rtt));
    this.heartbeat = deps.heartbeat ?? ((p) => { tvHeartbeat(deps.itemId, p); });
    this.volume = deps.volume ?? (() => readTv(deps.itemId).volume);
    this.onEnded = deps.onEnded ?? (() => { tvStop(deps.itemId); });
  }

  /** The room's playback as of this tick (what the UI shows). */
  current(): PlaybackNow {
    return this.playback(this.now(), this.rttMs());
  }

  /** Drive every ~250–500 ms. Idempotent: a tick with nothing to change
   *  touches nothing. */
  tick(): PlaybackNow {
    const now = this.now();
    const pb = this.playback(now, this.rttMs());
    const p = this.deps.player;
    const vol = this.volume();
    if (vol !== this.appliedVolume) {
      p.setVolume(vol);
      this.appliedVolume = vol;
    }
    if (!p.isReady()) return pb;

    if (pb.state === 'playing') {
      this.parked = false;
      if (p.isEnded()) {
        // Never play() an ended player (it would start over). The holder
        // closes the programme, once; a viewer holds until the record moves.
        if (this.iHold() && !this.endedHandled) {
          this.endedHandled = true;
          this.onEnded();
        }
        return pb;
      }
      this.endedHandled = false;
      if (!p.isPlaying()) p.play();
      const action = driftAction(p.currentMs(), pb.positionMs, p.canNudge);
      if (action === 'seek') {
        if (p.canSeek && now - this.lastSeekAt >= TV_SEEK_COOLDOWN_MS) {
          p.seek(pb.positionMs);
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
      // The holder is the clock: its own player's position goes out on the
      // heartbeat (after any seek above, so a remote-driven jump is what
      // gets reported, not where the player was before it).
      if (this.iHold() && now - this.lastBeatAt >= TV_HEARTBEAT_MS) {
        this.heartbeat(p.currentMs());
        this.lastBeatAt = now;
      }
      return pb;
    }

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

  private setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    this.deps.player.setRate(rate);
  }
}
