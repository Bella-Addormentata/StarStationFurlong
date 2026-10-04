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
 *    position a jump is still leaving behind. A scheduled countdown's T0
 *    is followed like any transport write: the holder's first tick past it
 *    goes where its own clock says the programme is (the time since T0 —
 *    the parked 0 when the tick is on time, a seek to the elapsed when a
 *    throttled tab's tick comes late), and its first heartbeat from there
 *    is the write the room starts on.
 */

import {
  driftAction, iHoldRemote, readPlayback, readTv, tvHeartbeat, tvNow, tvStop,
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
  /** Where the player can seek, in ms, when it knows: a file's [0, length],
   *  a live stream's sliding window (an HTML <video>'s `seekable` ranges);
   *  null until it knows (YouTube before its metadata, an HTML video before
   *  its ranges) and for the archive embed, which never says. */
  seekableRange(): SeekableRange | null;
  setRate(rate: number): void;
  setVolume(volume: number): void;
}

export interface SeekableRange {
  startMs: number;
  endMs: number;
}

/** The position a player can actually reach for `ms`: a player clamps a
 *  seek into its seekable range (past the end of a file is its end; before a
 *  live window is the window's start), so the target must agree with it or
 *  it would never be reached — the seek would never "land", and a holder
 *  would wait on it for good. A player that does not know its range yet
 *  takes the position as asked; the range is applied again once it does. */
function reachable(ms: number, p: TvPlayer): number {
  const range = p.seekableRange();
  if (!range) return ms;
  return Math.min(Math.max(ms, range.startMs), range.endMs);
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
  /** The record's programme revision (tvDoc `started`): a new one is a new
   *  programme, a replay of the same source included. */
  started?: () => number;
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

/** How long the holder waits on a transport target: for a player that
 *  cannot seek YET (an HTML video reports ready at its metadata, before its
 *  ranges) before deciding it never will (a live stream); and for a seek
 *  that went out to land, before deciding it never will (a seek YouTube
 *  swallowed, a host that stopped answering) — either way the target is
 *  dropped and the room follows wherever the player is, rather than
 *  keeping no clock at all. */
export const TV_SEEK_WAIT_MS = 10_000;

export class TvSyncController {
  private readonly now: () => number;
  private readonly rttMs: () => number;
  private readonly iHold: () => boolean;
  private readonly playback: (now: number, rttMs: number) => PlaybackNow;
  private readonly jump: () => number;
  private readonly started: () => number;
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
  /** Whether the seek for pendingTarget has gone out, and since when the
   *  target waits (a player that cannot seek yet keeps it, bounded). */
  private pendingSeekIssued = false;
  private pendingSince = -Infinity;
  /** Where the player read as the pending seek went out: a seek has landed
   *  only once the player reads on the target's side of that. A lazy
   *  player (YouTube's seekTo) reports its OLD position until the seek
   *  completes, and the drift band alone would call a replay of a
   *  one-second clip from 800 ms "landed" at 800 ms — the old run's
   *  position published as the new programme's, and the old run's end
   *  closing the new programme. */
  private seekFrom = 0;
  /** A viewer: the transport revision it last saw, to tell a transport
   *  write (a replay, a rewind) from the record lagging its ended player. */
  private seenJump: number | null = null;
  /** A replay a transport write asked of this viewer's ended player (the
   *  record before the player's end), owed until the player un-ends: the
   *  revision that asked, and the revision a seek last went out for. A new
   *  revision supersedes the last seek at once; the cooldown is for retries
   *  of the same one while an asynchronous player still reports ended at
   *  its old position. Otherwise a PLAY NOW inside the cooldown of the seek
   *  that landed the previous replay was dropped for good: the write
   *  already seen, the rewind inside the band, a clip shorter than the band
   *  left at its end. */
  private replayDue: number | null = null;
  private replayIssuedFor: number | null = null;
  /** The programme revision this controller last saw (tvDoc `started`):
   *  a change is a NEW PROGRAMME, which restarts either role's player
   *  whatever the drift band says — PLAY NOW again while the last run still
   *  played puts a one-second clip's player at 800 ms "within the band" of
   *  the new start, and left there it runs to its end and closes the new
   *  programme as ended. Null until the first tick: joining mid-programme
   *  is not a restart. */
  private seenStarted: number | null = null;
  /** The transport revision of a countdown this controller parked for
   *  (tvDoc `jump`, as SCHEDULE wrote it): the holder's first playing tick
   *  past T0 follows it like any jump — to the time since T0 — and forgets
   *  it. Null outside a countdown, and once followed. */
  private countdownJump: number | null = null;

  constructor(private readonly deps: TvSyncDeps) {
    this.now = deps.now ?? tvNow; // monotonic: cadences and the receipt timeline, never a date
    this.rttMs = deps.rttMs ?? (() => 0);
    this.iHold = deps.iHold ?? (() => iHoldRemote(deps.itemId));
    this.playback = deps.playback ?? ((now, rtt) => readPlayback(deps.itemId, now, rtt));
    this.jump = deps.jump ?? (() => readTv(deps.itemId).jump);
    this.started = deps.started ?? (() => readTv(deps.itemId).started);
    this.heartbeat = deps.heartbeat ?? ((p) => { tvHeartbeat(deps.itemId, p); });
    this.volume = deps.volume ?? (() => readTv(deps.itemId).volume);
    this.onEnded = deps.onEnded ?? (() => { tvStop(deps.itemId); });
  }

  /** The lead for this page: half the round trip to its own node for a
   *  viewer (the last hop only; the delivery delay before it stays — see
   *  expectedPositionMs), none for the holder, whose own writes land here
   *  without crossing a wire. */
  private lead(): number {
    return this.iHold() ? 0 : this.rttMs();
  }

  /** The room's playback as of this tick (what the UI shows). */
  current(): PlaybackNow {
    return this.playback(this.now(), this.lead());
  }

  /** Where the room is, for a transport write from this page (a pause, ±10 s).
   *  In order: the record's own position while a transport write stands
   *  that this holder has not followed yet (the newest word — two +10 s in
   *  a row before a tick must add up, not both read the target before
   *  them); then the target a jump is still carrying the player to (the
   *  player reads where it WAS until the seek lands, and a pause written
   *  from that would park the room there, footage unplayed); then the
   *  player's clock, once in step. A viewer's player is only ever where it
   *  is. */
  positionMs(): number {
    if (!this.iHold()) return this.deps.player.currentMs();
    const jump = this.jump();
    if (jump !== this.appliedJump || jump === this.countdownJump) return this.current().positionMs;
    if (this.pendingTarget !== null) return this.pendingTarget;
    return this.deps.player.currentMs();
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
    // A new programme since the last tick (see seenStarted): a restart for
    // either role below, band or no band.
    const started = this.started();
    const newProgramme = this.seenStarted !== null && started !== this.seenStarted;
    this.seenStarted = started;

    if (pb.state === 'playing') {
      this.parked = false;
      if (hold) return this.tickHolder(p, pb, now, newProgramme);
      // A viewer has no target of its own: whatever this page was carrying
      // its player to as the holder is the new holder's affair now, and
      // picking the remote up again later is a first acquisition — the
      // room's position followed once, then the player heartbeated — not a
      // return to a jump followed long ago, with a seek that never landed
      // still withholding every beat.
      this.pendingTarget = null;
      this.pendingSeekIssued = false;
      this.appliedJump = null;
      this.countdownJump = null;
      return this.tickViewer(p, pb, now, newProgramme);
    }

    // Not playing: whatever transport revision brought us here is followed
    // by the state itself (a later resume is a new revision to follow) —
    // except the holder's own transport while paused, which is a target of
    // its own below, and a schedule's, which the first tick past T0 follows
    // (further below).
    const jump = this.jump();

    if (pb.state === 'paused') {
      if (p.isPlaying()) p.pause();
      this.setRate(1);
      if (hold) {
        // The holder's transport while paused — ±10 s, or a pause written
        // over a seek still landing — is aimed and settled like any jump:
        // the paused position becomes the pending target, so positionMs()
        // names it until the seek lands and a second +10 s before then adds
        // up instead of asking for the same 20 s twice; the newest target
        // always replaces one still landing, with the same bounded wait. A
        // pause within the band of where the player reads, with nothing
        // landing, is a pause where it played: nothing to follow.
        if (jump !== this.appliedJump || this.pendingTarget !== null) {
          const target = reachable(pb.positionMs, p);
          const landing = this.pendingTarget !== null;
          if (this.pendingTarget !== target
            && (landing || Math.abs(p.currentMs() - target) > TV_SEEK_OVER_MS)
            && (p.canSeek || p.hasClock)) {
            this.aim(p, target, now);
          }
        }
        this.appliedJump = jump;
        this.settlePending(p, now);
      } else {
        this.appliedJump = jump;
        this.pendingTarget = null;
        if (p.canSeek && Math.abs(p.currentMs() - pb.positionMs) > TV_SEEK_OVER_MS
          && now - this.lastSeekAt >= TV_SEEK_COOLDOWN_MS) {
          p.seek(pb.positionMs);
          this.lastSeekAt = now;
        }
      }
      return pb;
    }

    // Scheduled, home or off: the programme is not running; a target from
    // before is void, and the revision that brought us here is followed by
    // the state itself — a schedule's once more at T0, below.
    this.appliedJump = jump;
    this.pendingTarget = null;

    if (pb.state === 'scheduled') {
      // The countdown parks the player at 0, once — and the holder's first
      // tick past T0 follows the schedule's revision like any jump
      // (countdownJump), to where its clock says the programme is: the time
      // since T0 (plan §3.1 — the start is the holder's wall clock against
      // startAt). A tick on time finds that inside the band of the parked 0
      // and starts from the top; one that comes late (a throttled
      // background tab, seconds or a minute past T0) seeks to the elapsed
      // and beats from there — where the headless beat, and a room whose
      // remote lapsed, already run from. Without this, that late tick
      // started the parked player at 0 and published 0: the schedule's
      // start moved to whenever the holder got round to it, and anyone
      // running from T0 was yanked back. Noted on every scheduled tick, so
      // a set switched off and on during the countdown still follows at T0.
      this.countdownJump = jump;
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
  private tickHolder(p: TvPlayer, pb: PlaybackNow, now: number, newProgramme: boolean): PlaybackNow {
    const jump = this.jump();
    if (jump !== this.appliedJump || jump === this.countdownJump) {
      // PLAY NOW, a remote seek, a resume — or a countdown's T0, whose
      // position is the time since it (countdownJump): go where the write
      // says, now (no cooldown — this is the one time the record drives the
      // holder). Within the seek band nothing moves: a player that is
      // already there (PLAY NOW from the top, a resume where it paused, a
      // countdown's parked 0 at a tick on time) stays put.
      this.appliedJump = jump;
      this.countdownJump = null;
      this.endedHandled = false;
      // A target the player cannot reach (+10 s with five left; a rewind
      // out of a live window) is clamped where the player would clamp the
      // seek, or it would never be reached and the programme never closed.
      const target = reachable(pb.positionMs, p);
      // While an earlier seek is still landing, the newest target is always
      // reissued — even inside the band of where the player still reads —
      // or the old seek would land later and be heartbeated over this one.
      const landing = this.pendingTarget !== null;
      // And a transport write to a player that has ENDED is always a seek:
      // the band is for a player already where the write says (a resume
      // where it paused), but an ended player is nowhere — a replay of a
      // clip shorter than the band would otherwise be "within it", never
      // seeked, and closed again as ended on the very next line.
      // A player that cannot seek YET (hasClock, !canSeek) keeps the target
      // too, and the beat waits with it; a start-only embed keeps nothing.
      // And a NEW PROGRAMME is always a seek (seenStarted): the band is for
      // a player already where this programme's write says, and a player
      // still running the last programme is nowhere in this one.
      if ((landing || newProgramme || p.isEnded() || Math.abs(p.currentMs() - target) > TV_SEEK_OVER_MS) && (p.canSeek || p.hasClock)) {
        this.aim(p, target, now);
      }
    }
    this.settlePending(p, now);
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

  /** The holder takes aim at a transport target: the seek goes out now if
   *  the player can seek, else it waits (an HTML video reports ready at its
   *  metadata, before its ranges) — the target is kept either way, and no
   *  beat goes out until it has landed. */
  private aim(p: TvPlayer, target: number, now: number): void {
    if (p.canSeek) {
      this.seekFrom = p.currentMs();
      p.seek(target);
      this.lastSeekAt = now;
      this.pendingSeekIssued = true;
    } else {
      this.pendingSeekIssued = false;
    }
    this.pendingTarget = target;
    this.pendingSince = now;
  }

  /** The holder's pending target: issue the seek on the first tick the
   *  player can; give it up after TV_SEEK_WAIT_MS on one that never can (a
   *  live stream — the room then follows the player); and clear it once
   *  landed — within the band, checked every tick, not only when a beat is
   *  due, so a player that then runs to its end (a replay of a short film)
   *  is seen to end. Clamped again here, into a range the player may not
   *  have known at the jump (YouTube's length arrives with its metadata; a
   *  live window slides); and a FORWARD seek that ended the player has
   *  landed wherever the media stops, whether or not it ever said how long
   *  it was — a backward one from the end has not, however short, until
   *  the player un-ends (an asynchronous player keeps reporting its old
   *  ended position meanwhile, and a replay of a clip shorter than the band
   *  would otherwise read as landed and be closed again as ended). A seek
   *  that went out and has not landed TV_SEEK_WAIT_MS later never will
   *  (swallowed, or a host that stopped answering): the target is dropped,
   *  so the beat resumes from wherever the player is — a room with a clock
   *  a jump behind, over one with no clock at all. */
  private settlePending(p: TvPlayer, now: number): void {
    if (this.pendingTarget === null) return;
    if (!this.pendingSeekIssued) {
      if (p.canSeek) {
        this.seekFrom = p.currentMs();
        p.seek(this.pendingTarget);
        this.lastSeekAt = now;
        this.pendingSeekIssued = true;
        this.pendingSince = now; // the wait starts over: now for the seek to land
      } else {
        if (now - this.pendingSince >= TV_SEEK_WAIT_MS) this.pendingTarget = null;
        return;
      }
    }
    const target = reachable(this.pendingTarget, p);
    const at = p.currentMs();
    // Landed: inside the band of the target AND on the target's side of
    // where the player read as the seek went out (seekFrom) — a backward
    // seek once the player reads before that, a forward one once it reads
    // past it, a seek to where it stood at once. The band alone is drift
    // tolerance, and a lazy player still reading its old position inside
    // the band has not moved at all. An ended player's forward seek has
    // landed wherever the media stops; a backward one from the end has not
    // until the player un-ends.
    const back = target < this.seekFrom;
    const moved = this.seekFrom === target || (back ? at < this.seekFrom : at > this.seekFrom);
    const landed = p.isEnded() ? target >= at : Math.abs(at - target) <= TV_SEEK_OVER_MS && moved;
    if (landed || now - this.pendingSince >= TV_SEEK_WAIT_MS) this.pendingTarget = null;
  }

  /** A viewer: converge on the record (seek when far, nudge when near). */
  private tickViewer(p: TvPlayer, pb: PlaybackNow, now: number, newProgramme: boolean): PlaybackNow {
    // A transport write since this viewer's last tick (PLAY NOW again, a
    // rewind): told apart from the record merely lagging the player, which
    // is every tick near the end of a film.
    const jump = this.jump();
    const transport = this.seenJump !== null && jump !== this.seenJump;
    this.seenJump = jump;
    if (p.isEnded()) {
      // A player at its end is never play()ed as it stands (it would start
      // over). A record well BEFORE the end is a rewind or a replay: seek
      // there — which un-ends the player — and go; so is a record anywhere
      // before the end on a transport write (a replay of a clip shorter
      // than the band, which sample lag alone could never explain) — owed
      // from then on, until the player un-ends. A seek for a NEW revision
      // goes out at once; retries of the same one, and a rewind no write
      // asked for, wait out the cooldown of any viewer seek: an asynchronous
      // player keeps reporting ended at its old position until the seek
      // lands, and a seek and a play() every tick meanwhile would only
      // interrupt its buffering. Otherwise hold until the record moves on
      // (the holder ends the programme).
      const before = pb.positionMs < p.currentMs();
      if ((transport && before) || newProgramme) this.replayDue = jump;
      const far = pb.positionMs < p.currentMs() - TV_SEEK_OVER_MS;
      const owed = this.replayDue !== null;
      const fresh = owed && this.replayDue !== this.replayIssuedFor;
      if (p.canSeek && (far || owed) && (fresh || now - this.lastSeekAt >= TV_SEEK_COOLDOWN_MS)) {
        p.seek(pb.positionMs);
        this.lastSeekAt = now;
        this.replayIssuedFor = this.replayDue;
        this.setRate(1);
        p.play();
      }
      return pb;
    }
    this.replayDue = null;
    this.replayIssuedFor = null;
    if (!p.isPlaying()) p.play();
    // A new programme on a player still running the last one (a replay of
    // a short clip before its end): go where the record says — band, nudge
    // and cooldown are for drift within ONE programme.
    if (newProgramme && p.canSeek) {
      p.seek(reachable(pb.positionMs, p));
      this.lastSeekAt = now;
      this.setRate(1);
      return pb;
    }
    const action = driftAction(p.currentMs(), pb.positionMs, p.canNudge);
    if (action === 'seek') {
      if (p.canSeek && now - this.lastSeekAt >= TV_SEEK_COOLDOWN_MS) {
        // Into this player's own range: the record may name a position this
        // viewer's media does not have (a live window that has moved on).
        p.seek(reachable(pb.positionMs, p));
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
