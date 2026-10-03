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
      if (p.isEnded()) {
        // A player at its end is never play()ed as it stands (it would start
        // over). A record well BEFORE the end is a rewind or a replay: seek
        // there — which un-ends the player — and go. Otherwise the holder
        // closes the programme, once; a viewer holds until the record moves.
        if (p.canSeek && pb.positionMs < p.currentMs() - TV_SEEK_OVER_MS) {
          p.seek(pb.positionMs);
          this.lastSeekAt = now;
          this.setRate(1);
          this.endedHandled = false;
          p.play();
          return pb;
        }
        if (hold && !this.endedHandled) {
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
      // heartbeat — from a player that HAS a clock (the archive embed reports
      // nothing; the headless beat keeps the room's clock for it), and only
      // once the player is back within the band of the record. A seek still
      // landing (YouTube's is asynchronous) or deferred by the cooldown
      // leaves the player far from the record, and publishing where it still
      // is would undo the very jump that was asked for.
      if (hold && p.hasClock && now - this.lastBeatAt >= TV_HEARTBEAT_MS
        && Math.abs(p.currentMs() - pb.positionMs) <= TV_SEEK_OVER_MS) {
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
