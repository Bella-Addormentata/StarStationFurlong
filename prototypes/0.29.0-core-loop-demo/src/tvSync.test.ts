/**
 * 📺 tvSync — the controller against a fake player and a fake clock: a
 * viewer seeks when far, nudges when near, and leaves a YouTube-shaped player
 * alone inside the band; the holder heartbeats from its own player; a
 * scheduled programme parks at 0 and starts at T0; a paused one holds.
 */
import { describe, expect, it } from 'vitest';
import { TvSyncController, TV_SEEK_COOLDOWN_MS, TV_SEEK_WAIT_MS } from './tvSync';
import type { TvPlayer } from './tvSync';
import { TV_HEARTBEAT_MS, TV_NUDGE_RATE } from './tvDoc';
import type { PlaybackNow } from './tvDoc';

class FakePlayer implements TvPlayer {
  position = 0;
  playing = false;
  ready = true;
  ended = false;
  rate = 1;
  volume = -1;
  log: string[] = [];
  /** A lazy player's seek lands only on land() — YouTube's asynchronous seekTo. */
  lazy = false;
  /** The media's length: where a seek is clamped and the player ends (a
   *  player knows its end before it can say so); NaN for a live stream. */
  duration = NaN;
  /** A live stream's sliding window: seeks clamp into it (never "ended"),
   *  and it is what seekableRange() reports, over a file's [0, duration]. */
  window: { startMs: number; endMs: number } | null = null;
  /** Whether the player has said yet where it can seek (YouTube before its
   *  metadata, an HTML video before its ranges: nothing to clamp to). */
  reportsRange = true;
  private pendingSeek: number | null = null;
  /** `canSeek` is mutable: an HTML video's ranges arrive after its metadata. */
  constructor(public readonly canNudge: boolean, public canSeek = true, public readonly hasClock = true) {}
  isReady() { return this.ready; }
  isPlaying() { return this.playing; }
  isEnded() { return this.ended; }
  play() { this.playing = true; this.log.push('play'); }
  pause() { this.playing = false; this.log.push('pause'); }
  /** A seek lands at once (unless lazy): past the end is the end, and ended;
   *  anywhere else un-ends the player as a <video>'s does. */
  seek(ms: number) {
    this.log.push(`seek:${ms}`);
    if (this.lazy) { this.pendingSeek = ms; return; }
    this.arrive(ms);
  }
  land() {
    if (this.pendingSeek === null) return;
    const ms = this.pendingSeek;
    this.pendingSeek = null;
    this.arrive(ms);
  }
  private arrive(ms: number) {
    const start = this.window ? this.window.startMs : 0;
    const end = this.window ? this.window.endMs : Number.isFinite(this.duration) ? this.duration : Infinity;
    this.position = Math.min(Math.max(ms, start), end);
    this.ended = !this.window && this.position >= end;
  }
  currentMs() { return this.position; }
  seekableRange() {
    if (!this.reportsRange) return null;
    if (this.window) return { ...this.window };
    return Number.isFinite(this.duration) ? { startMs: 0, endMs: this.duration } : null;
  }
  setRate(rate: number) { this.rate = rate; this.log.push(`rate:${rate.toFixed(2)}`); }
  setVolume(v: number) { this.volume = v; }
}

/** `opts.hold` is read on every tick: a test flips it to hand the remote over. */
function harness(player: TvPlayer, opts: { hold?: boolean; rtt?: number; onEnded?: () => void } = {}) {
  let now = 100_000;
  let pb: PlaybackNow = { state: 'playing', positionMs: 0, running: true, countdownMs: 0 };
  let jump = 0;
  const beats: number[] = [];
  const c = new TvSyncController({
    itemId: 'tv-1',
    player,
    now: () => now,
    rttMs: () => opts.rtt ?? 0,
    iHold: () => opts.hold ?? false,
    playback: () => pb,
    jump: () => jump,
    heartbeat: (p) => beats.push(p),
    volume: () => 55,
    onEnded: opts.onEnded,
  });
  return {
    c, beats,
    set: (next: Partial<PlaybackNow>) => { pb = { ...pb, ...next }; },
    /** A transport write (a seek, PLAY NOW, a resume): the record's `jump` moves. */
    transport: (next: Partial<PlaybackNow>) => { pb = { ...pb, ...next }; jump += 1; },
    tick: (ms = 500) => { now += ms; return c.tick(); },
  };
}

describe('a viewer following the room', () => {
  it('starts playing, applies the set volume once, and seeks when far behind', () => {
    const p = new FakePlayer(true);
    const h = harness(p);
    h.set({ positionMs: 30_000 });
    h.tick();
    expect(p.volume).toBe(55);
    expect(p.log).toEqual(['play', 'seek:30000']);
  });

  it('nudges the rate inside the band and settles back to 1×', () => {
    const p = new FakePlayer(true);
    const h = harness(p);
    p.position = 10_000;
    h.set({ positionMs: 10_600 }); // 600 ms behind: speed up
    h.tick();
    expect(p.rate).toBeCloseTo(1 + TV_NUDGE_RATE);
    p.position = 10_650;
    h.set({ positionMs: 10_700 }); // inside the dead band: back to 1×
    h.tick();
    expect(p.rate).toBe(1);
    p.position = 12_000;
    h.set({ positionMs: 11_400 }); // 600 ms ahead: slow down
    h.tick();
    expect(p.rate).toBeCloseTo(1 - TV_NUDGE_RATE);
  });

  it('a YouTube-shaped player (no fine rate) only ever seeks, and only past the band', () => {
    const p = new FakePlayer(false);
    const h = harness(p);
    p.position = 10_000;
    h.set({ positionMs: 11_000 });
    h.tick();
    expect(p.log).toEqual(['play']); // 1 s off: left alone
    h.set({ positionMs: 12_000 });
    h.tick();
    expect(p.log).toEqual(['play', 'seek:12000']);
    expect(p.rate).toBe(1);
  });

  it('does not seek again while the last seek is still buffering', () => {
    const p = new FakePlayer(true);
    const h = harness(p);
    h.set({ positionMs: 30_000 });
    h.tick();
    p.position = 0; // the seek has not landed yet
    h.set({ positionMs: 30_500 });
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toHaveLength(1);
    h.tick(TV_SEEK_COOLDOWN_MS);
    expect(p.log.filter((l) => l.startsWith('seek'))).toHaveLength(2);
  });

  it('a start-only embed never seeks, and is simply played', () => {
    const p = new FakePlayer(false, false);
    const h = harness(p);
    h.set({ positionMs: 90_000 });
    h.tick();
    expect(p.log).toEqual(['play']);
  });

  it('seeks into its own window when the record names a position its stream no longer has', () => {
    const p = new FakePlayer(true);
    p.window = { startMs: 50_000, endMs: 60_000 };
    p.position = 55_000;
    const h = harness(p);
    h.set({ positionMs: 10_000 });
    h.tick();
    expect(p.log).toEqual(['play', 'seek:50000']);
  });

  it('holds on pause (and jumps to the paused position when far from it)', () => {
    const p = new FakePlayer(true);
    const h = harness(p);
    h.tick();
    p.position = 5_000;
    h.set({ state: 'paused', positionMs: 20_000, running: false });
    h.tick();
    expect(p.playing).toBe(false);
    expect(p.position).toBe(20_000);
  });

  it('parks at 0 during a countdown, once, and goes at T0', () => {
    const p = new FakePlayer(true);
    const h = harness(p);
    p.position = 4_000;
    p.playing = true;
    h.set({ state: 'scheduled', positionMs: 0, running: false, countdownMs: 2_000 });
    h.tick();
    h.tick();
    expect(p.log).toEqual(['pause', 'seek:0']);
    h.set({ state: 'playing', positionMs: 300, running: true, countdownMs: 0 });
    h.tick();
    expect(p.playing).toBe(true);
  });

  it('applies nothing to a player that is not ready — the volume included — and pauses when the TV goes off', () => {
    const p = new FakePlayer(true);
    p.ready = false;
    const h = harness(p);
    h.set({ positionMs: 30_000 });
    h.tick();
    expect(p.log).toEqual([]);
    expect(p.volume).toBe(-1); // a YouTube player swallows setVolume before onReady: not cached as applied
    p.ready = true;
    h.set({ state: 'off', positionMs: 0, running: false });
    p.playing = true;
    h.tick();
    expect(p.log).toEqual(['pause']);
    expect(p.volume).toBe(55);
  });

  it('hands the round trip to the playback read for a viewer, and zero for the holder (its own writes land here)', () => {
    const leads: number[] = [];
    const make = (hold: boolean) => new TvSyncController({
      itemId: 'tv-1', player: new FakePlayer(true), now: () => 100_000, rttMs: () => 1_000,
      iHold: () => hold, volume: () => 50, heartbeat: () => undefined,
      playback: (_now, rtt) => {
        leads.push(rtt);
        return { state: 'playing', positionMs: 0, running: true, countdownMs: 0 };
      },
    });
    make(false).tick();
    make(true).tick();
    make(false).current();
    make(true).current();
    expect(leads).toEqual([1_000, 0, 1_000, 0]);
  });

  it('a player that ended follows a rewind, and the holder can end a replayed programme again', () => {
    const viewer = new FakePlayer(true);
    const hv = harness(viewer);
    hv.tick();
    viewer.position = 60_000;
    viewer.playing = false;
    viewer.ended = true;
    hv.set({ positionMs: 60_100 }); // at the end with the room: wait
    hv.tick();
    expect(viewer.log).toEqual(['play']);
    hv.set({ positionMs: 10_000 }); // the holder rewound
    hv.tick();
    expect(viewer.log).toEqual(['play', 'seek:10000', 'play']);
    expect(viewer.ended).toBe(false);
    expect(viewer.playing).toBe(true);

    const holder = new FakePlayer(true);
    let now = 100_000;
    let pos = 0;
    let jump = 0;
    let ended = 0;
    const c = new TvSyncController({
      itemId: 'tv-1', player: holder, now: () => now, iHold: () => true,
      playback: () => ({ state: 'playing', positionMs: pos, running: true, countdownMs: 0 }),
      jump: () => jump,
      heartbeat: () => undefined, volume: () => 50, onEnded: () => { ended++; },
    });
    c.tick();
    holder.position = 60_000; holder.playing = false; holder.ended = true; pos = 60_100;
    now += 500; c.tick();
    now += 500; c.tick();
    expect(ended).toBe(1);
    pos = 0; jump += 1; // PLAY NOW again: a transport write, from the top
    now += 500; c.tick();
    expect(holder.log.at(-2)).toBe('seek:0');
    expect(holder.ended).toBe(false);
    holder.position = 60_000; holder.playing = false; holder.ended = true; pos = 60_100;
    now += 500; c.tick();
    expect(ended).toBe(2); // the end counts again after a replay
  });
});

describe('a replay of a clip shorter than the seek band', () => {
  it('the holder seeks an ended player on a transport write however short the clip, and waits for the seek to land before calling it ended', () => {
    const holder = new FakePlayer(true);
    holder.lazy = true; // YouTube's asynchronous seekTo
    holder.duration = 1_000; // a one-second clip
    let now = 100_000;
    let pos = 0;
    let jump = 0;
    let ended = 0;
    const c = new TvSyncController({
      itemId: 'tv-1', player: holder, now: () => now, iHold: () => true,
      playback: () => ({ state: 'playing', positionMs: pos, running: true, countdownMs: 0 }),
      jump: () => jump,
      heartbeat: () => undefined, volume: () => 50, onEnded: () => { ended++; },
    });
    c.tick();
    holder.position = 1_000; holder.playing = false; holder.ended = true; pos = 1_000;
    now += 500; c.tick();
    expect(ended).toBe(1);
    pos = 0; jump += 1; // PLAY NOW again: from the top, 1 s from where the player ended — inside the band
    now += 500; c.tick();
    expect(holder.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:0']); // seeked all the same: an ended player is nowhere
    now += 500; c.tick(); // the seek has not landed: the player still reads ended at 1 s
    expect(ended).toBe(1); // not closed again on the old ended position
    holder.land();
    now += 500; c.tick();
    expect(holder.ended).toBe(false);
    expect(holder.playing).toBe(true);
    holder.position = 1_000; holder.playing = false; holder.ended = true; pos = 1_000;
    now += 500; c.tick();
    expect(ended).toBe(2); // the replay ran and ended, once
  });

  it('a viewer replays the clip on a transport write, not on the record merely lagging its ended player, and under the seek cooldown', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    p.duration = 1_000;
    const h = harness(p);
    h.tick();
    p.position = 1_000; p.playing = false; p.ended = true;
    h.set({ positionMs: 800 }); // the record lags the player's end by a sample: not a replay
    h.tick();
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual([]);
    h.transport({ positionMs: 0 }); // PLAY NOW again
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:0']);
    h.tick(); // still ended at 1 s while the seek lands: no second seek inside the cooldown
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:0']);
    p.land();
    h.tick();
    expect(p.ended).toBe(false);
    expect(p.playing).toBe(true);
  });

  it('a replay asked for inside the cooldown of the previous seek is not dropped: a new revision supersedes the last seek, and only its retries wait', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    p.duration = 1_000;
    const h = harness(p);
    h.tick();
    p.position = 1_000; p.playing = false; p.ended = true;
    h.set({ positionMs: 1_000 });
    h.transport({ positionMs: 0 }); // PLAY NOW: the first replay
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:0']);
    p.land(); // it lands and the clip plays again…
    h.tick();
    expect(p.ended).toBe(false);
    p.position = 1_000; p.playing = false; p.ended = true; // …and ends again, a second after that seek
    h.set({ positionMs: 1_000 });
    h.transport({ positionMs: 0 }); // PLAY NOW once more, inside the cooldown
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:0', 'seek:0']); // superseded at once, not dropped
    h.tick(); // a retry of the same revision waits for the cooldown while the seek lands
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:0', 'seek:0']);
    p.land();
    h.tick();
    expect(p.ended).toBe(false);
    expect(p.playing).toBe(true);
  });

  it('a viewer whose rewind is still landing is not seeked and played again every tick', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    const h = harness(p);
    h.tick();
    p.position = 60_000; p.playing = false; p.ended = true;
    h.set({ positionMs: 10_000 }); // the holder rewound
    h.tick();
    expect(p.log.filter((l) => l === 'play' || l.startsWith('seek'))).toEqual(['play', 'seek:10000', 'play']);
    h.tick();
    h.tick(); // 1 s on: the seek has not landed, the player still reads ended at 60 s
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:10000']);
    h.tick(TV_SEEK_COOLDOWN_MS); // past the cooldown: once more, at most
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:10000', 'seek:10000']);
    p.land();
    h.tick();
    expect(p.position).toBe(10_000);
    expect(p.ended).toBe(false);
  });
});

describe('an ended programme', () => {
  it('is never played again by a viewer, and is closed once by the holder', () => {
    const viewer = new FakePlayer(true);
    const hv = harness(viewer);
    hv.tick();
    viewer.playing = false;
    viewer.ended = true;
    hv.tick();
    hv.tick();
    expect(viewer.log).toEqual(['play']); // no second play() on an ended player
    const holder = new FakePlayer(true);
    let now = 100_000;
    let ended = 0;
    const c = new TvSyncController({
      itemId: 'tv-1', player: holder, now: () => now, iHold: () => true,
      playback: () => ({ state: 'playing', positionMs: 0, running: true, countdownMs: 0 }),
      heartbeat: () => undefined, volume: () => 50, onEnded: () => { ended++; },
    });
    c.tick();
    holder.playing = false;
    holder.ended = true;
    now += 500; c.tick();
    now += 500; c.tick();
    expect(ended).toBe(1);
  });
});

describe('the holder as the room\'s clock', () => {
  it('heartbeats its own player position every TV_HEARTBEAT_MS, and follows a remote seek once', () => {
    // The record follows the holder's own beats (its write lands on itself
    // at once and extrapolates from there, as readPlayback does live).
    const p = new FakePlayer(true);
    let now = 100_000;
    let sample = { positionMs: 0, receivedAt: now };
    let jump = 0;
    const beats: number[] = [];
    const c = new TvSyncController({
      itemId: 'tv-1',
      player: p,
      now: () => now,
      iHold: () => true,
      playback: () => ({
        state: 'playing', running: true, countdownMs: 0,
        positionMs: sample.positionMs + (now - sample.receivedAt),
      }),
      jump: () => jump,
      heartbeat: (pos) => { beats.push(pos); sample = { positionMs: pos, receivedAt: now }; },
      volume: () => 50,
    });
    p.position = 1_000;
    now += 500;
    c.tick();
    expect(beats).toEqual([1_000]);
    p.position = 2_000;
    now += 1_000;
    c.tick();
    expect(beats).toEqual([1_000]); // not yet
    p.position = 4_000;
    now += 2_000; // TV_HEARTBEAT_MS since the first beat
    c.tick();
    expect(beats).toEqual([1_000, 4_000]);
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual([]); // in step: never seeked itself
    // A seek written by the remote (a transport write: the record jumps far
    // and `jump` moves): the holder's player follows, and the SAME tick's
    // beat reports the new place.
    sample = { positionMs: 60_000, receivedAt: now };
    jump += 1;
    now += TV_HEARTBEAT_MS;
    c.tick();
    expect(p.position).toBe(63_000);
    expect(beats.at(-1)).toBe(63_000);
  });

  it('is never corrected by the record\'s own extrapolation: a buffering holder publishes where it is', () => {
    const p = new FakePlayer(true);
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    expect(h.beats).toEqual([0]);
    // The holder's player stalls at 10 s while the record (its own last
    // beat, extrapolated) says 20 s. No transport write happened.
    p.position = 10_000;
    h.set({ positionMs: 20_000 });
    h.tick(TV_HEARTBEAT_MS);
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual([]);
    expect(p.rate).toBe(1);
    expect(h.beats).toEqual([0, 10_000]); // the room follows the holder, not the other way round
  });

  it('does not beat while a transport seek is still landing (YouTube\'s is asynchronous)', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    expect(h.beats).toEqual([0]);
    h.transport({ positionMs: 30_000 }); // a remote seek
    h.tick(2_600);
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000']);
    h.tick(500); // a beat is due, but the seek has not landed: the player still reads 0
    expect(h.beats).toEqual([0]); // publishing 0 now would undo the jump
    p.land();
    h.tick(500);
    expect(h.beats).toEqual([0, 30_000]); // what landed is what goes out
  });

  it('a transport seek past the end lands at the end, and the programme is over — not stuck', () => {
    const p = new FakePlayer(true);
    p.duration = 60_000;
    let ended = 0;
    const h = harness(p, { hold: true, onEnded: () => { ended++; } });
    p.position = 55_000;
    h.set({ positionMs: 55_000 });
    h.tick(); // the baseline beat
    expect(h.beats).toEqual([55_000]);
    h.transport({ positionMs: 65_000 }); // +10 s with five left
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:60000']); // the end, not beyond it
    expect(p.ended).toBe(true);
    expect(ended).toBe(1); // over at once: no target left to wait for
    h.tick(TV_HEARTBEAT_MS);
    expect(ended).toBe(1);
  });

  it('a seek past an end the player has not announced still lands when the player ends there', () => {
    const p = new FakePlayer(true);
    p.duration = 60_000;
    p.reportsRange = false; // YouTube before its metadata: nothing to clamp to
    let ended = 0;
    const h = harness(p, { hold: true, onEnded: () => { ended++; } });
    p.position = 55_000;
    h.set({ positionMs: 55_000 });
    h.tick();
    h.transport({ positionMs: 65_000 });
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:65000']);
    expect(p.position).toBe(60_000); // the player stopped where the media does
    expect(ended).toBe(1); // a forward seek that ended the player has landed
  });

  it('an asynchronous rewind from the end is not mistaken for a landed seek', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    p.duration = 60_000;
    let ended = 0;
    const h = harness(p, { hold: true, onEnded: () => { ended++; } });
    h.tick(); // the baseline beat, at 0
    p.position = 60_000; p.playing = false; p.ended = true;
    h.set({ positionMs: 60_000 });
    h.tick(); // the programme ends once…
    expect(ended).toBe(1);
    h.transport({ positionMs: 0 }); // …and PLAY NOW replays it
    h.tick();
    expect(p.log.at(-1)).toBe('seek:0');
    h.tick(); // the seek has not landed: still at the end, still "ended"
    expect(ended).toBe(1); // not closed again — the jump is still landing
    expect(h.beats).toEqual([0]); // and nothing published meanwhile
    p.land();
    h.tick();
    expect(p.position).toBe(0);
    expect(p.playing).toBe(true);
  });

  it('a newer transport target replaces a seek still landing — the old one never beats over it', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    h.transport({ positionMs: 30_000 }); // a seek…
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000']);
    h.transport({ positionMs: 0 }); // …then PLAY NOW from the top before it lands: within the band of where the player still reads
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000', 'seek:0']);
    p.land(); // the newest target is what lands
    h.tick(TV_HEARTBEAT_MS);
    expect(p.position).toBe(0);
    expect(h.beats).toEqual([0, 0]);
  });

  it('keeps a jump the player cannot seek to YET, withholding the beat until the seek goes out', () => {
    const p = new FakePlayer(true);
    p.canSeek = false; // an HTML video: ready at its metadata, ranges still to come
    const h = harness(p, { hold: true });
    h.transport({ positionMs: 60_000 }); // the holder's theatre opens mid-programme
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual([]);
    expect(h.beats).toEqual([]); // publishing 0 now would rewind the room
    h.tick(2_000);
    expect(h.beats).toEqual([]);
    p.canSeek = true; // the ranges arrived
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:60000']);
    expect(p.position).toBe(60_000);
    expect(h.beats).toEqual([60_000]); // landed: the first beat is where the room is
  });

  it('gives a jump up after TV_SEEK_WAIT_MS on a player that never can seek (a live stream), and beats where it is', () => {
    const p = new FakePlayer(true);
    p.canSeek = false;
    const h = harness(p, { hold: true });
    h.transport({ positionMs: 60_000 });
    h.tick();
    expect(h.beats).toEqual([]);
    h.tick(TV_SEEK_WAIT_MS);
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual([]);
    expect(h.beats).toEqual([0]); // the room follows the player
  });

  it('gives up a seek that went out and never landed after TV_SEEK_WAIT_MS, and beats where the player is', () => {
    const p = new FakePlayer(true);
    p.lazy = true; // and never land()s: a seek YouTube swallowed
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    h.transport({ positionMs: 30_000 });
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000']);
    h.tick(TV_SEEK_WAIT_MS / 2);
    expect(h.beats).toEqual([0]); // still waiting on it
    h.tick(TV_SEEK_WAIT_MS / 2);
    expect(h.beats).toEqual([0, 0]); // given up: the room has a clock again, the player's
    expect(h.c.positionMs()).toBe(0); // and nothing is pending any more
  });

  it('a seek issued late (the ranges arrived) gets its own full wait to land', () => {
    const p = new FakePlayer(true);
    p.canSeek = false;
    const h = harness(p, { hold: true });
    h.transport({ positionMs: 60_000 });
    h.tick();
    h.tick(TV_SEEK_WAIT_MS - 2_000); // kept, not yet given up
    expect(h.beats).toEqual([]);
    p.canSeek = true;
    p.lazy = true;
    h.tick(); // the seek goes out now…
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:60000']);
    h.tick(TV_SEEK_WAIT_MS - 2_000); // …and the 8 s it waited before do not count against it
    expect(h.beats).toEqual([]);
    h.tick(2_000);
    expect(h.beats).toEqual([0]); // given up only TV_SEEK_WAIT_MS after it went out
  });

  it('a rewind out of a live window lands at the window\'s start, and the room follows from there', () => {
    const p = new FakePlayer(true);
    p.window = { startMs: 50_000, endMs: 60_000 }; // a live stream's DVR window
    p.position = 58_000;
    const h = harness(p, { hold: true });
    h.set({ positionMs: 58_000 });
    h.tick(); // the baseline beat
    expect(h.beats).toEqual([58_000]);
    h.transport({ positionMs: 10_000 }); // a rewind the stream no longer has
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:50000']); // the window's start, not before it
    h.tick(TV_HEARTBEAT_MS);
    expect(h.beats).toEqual([58_000, 50_000]); // landed, and the room is told where
  });

  it('a seek into a window that moved on meanwhile is still seen to land', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    p.window = { startMs: 50_000, endMs: 60_000 };
    p.position = 58_000;
    const h = harness(p, { hold: true });
    h.set({ positionMs: 58_000 });
    h.tick();
    h.transport({ positionMs: 10_000 });
    h.tick(); // aimed at 50 000…
    p.window = { startMs: 52_000, endMs: 62_000 }; // …but the window slid before the seek landed
    p.land(); // the player clamps it to 52 000
    h.tick(TV_HEARTBEAT_MS);
    expect(p.position).toBe(52_000);
    expect(h.beats).toEqual([58_000, 52_000]); // landed where the player could go, not stuck at 50 000
  });

  it('a seek still landing is not forgotten by a pause: the paused position is re-aimed, and the old seek never lands over it', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    h.transport({ positionMs: 30_000 }); // a seek, in flight
    h.tick();
    h.transport({ state: 'paused', positionMs: 0, running: false }); // paused where the player still reads: 0
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000', 'seek:0']);
    h.transport({ state: 'playing', positionMs: 0, running: true }); // resumed before anything landed
    h.tick();
    p.land(); // the newest seek is what lands
    h.tick(TV_HEARTBEAT_MS);
    expect(p.position).toBe(0);
    expect(h.beats).toEqual([0, 0]);
  });

  it('a holder\'s seek while paused is a pending target: a second +10 s before it lands adds up, and the paused room never beats', () => {
    const p = new FakePlayer(true);
    p.lazy = true; // YouTube's asynchronous seekTo
    const h = harness(p, { hold: true });
    p.position = 10_000;
    h.set({ positionMs: 10_000 });
    h.tick(); // playing at 10 s: the baseline beat
    h.transport({ state: 'paused', positionMs: 10_000, running: false }); // paused where it played
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual([]); // within the band: nothing to follow
    expect(h.c.positionMs()).toBe(10_000);
    h.transport({ positionMs: h.c.positionMs() + 10_000 }); // the phone's +10 s, from where the room is
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:20000']);
    expect(h.c.positionMs()).toBe(20_000); // the target, while the seek is still landing — not the stale 10 s
    h.transport({ positionMs: h.c.positionMs() + 10_000 }); // another +10 s before it lands: 30 s, not 20 s again
    h.tick();
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:20000', 'seek:30000']);
    p.land();
    h.tick();
    expect(p.position).toBe(30_000);
    expect(h.c.positionMs()).toBe(30_000); // landed: the player's own clock again
    expect(h.beats).toEqual([10_000]); // paused: no beat went out
    // A seek that never lands while paused is given up after the wait, like any.
    h.transport({ positionMs: 40_000 });
    h.tick();
    expect(h.c.positionMs()).toBe(40_000);
    h.tick(TV_SEEK_WAIT_MS);
    expect(h.c.positionMs()).toBe(30_000); // the target dropped: the player, wherever it is
  });

  it('a hand-over while a seek is still landing leaves nothing behind: picked up again, the page follows the room once and beats from there', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    const opts = { hold: true };
    const h = harness(p, opts);
    h.tick(); // the baseline beat, at 0
    h.transport({ positionMs: 30_000 }); // a seek, in flight…
    h.tick();
    expect(h.c.positionMs()).toBe(30_000);
    opts.hold = false; // …and the remote is handed over before it lands
    h.set({ positionMs: 45_000 }); // the new holder has moved the room on
    h.tick(TV_SEEK_COOLDOWN_MS); // a viewer now: follows the record, carries no target
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000', 'seek:45000']);
    expect(h.c.positionMs()).toBe(0); // the player's own clock: nothing pending for a viewer
    p.land();
    expect(p.position).toBe(45_000);
    opts.hold = true; // picked up again, no transport write since: `jump` unchanged
    h.set({ positionMs: 46_000 });
    h.tick(TV_HEARTBEAT_MS);
    expect(p.log.filter((l) => l.startsWith('seek'))).toHaveLength(2); // within the band of the room: nothing to follow
    expect(h.beats).toEqual([0, 45_000]); // the beat is not withheld by the old 30 s target
    // Picked up far from the room (the player stalled while viewing): the
    // room's position is followed once, as on a first pick-up.
    opts.hold = false;
    h.tick();
    p.position = 20_000;
    opts.hold = true;
    h.set({ positionMs: 50_000 });
    h.tick(TV_SEEK_COOLDOWN_MS);
    expect(p.log.filter((l) => l.startsWith('seek')).at(-1)).toBe('seek:50000');
  });

  it('names where the room is for a transport write: the target a jump still carries the player to, the record for a jump not yet followed, else the player', () => {
    const p = new FakePlayer(true);
    p.lazy = true;
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    expect(h.c.positionMs()).toBe(0); // in step: the player's clock
    h.transport({ positionMs: 30_000 }); // a remote seek, not ticked yet
    expect(h.c.positionMs()).toBe(30_000); // the record's word, not the player's stale 0
    h.tick(); // the seek goes out and has not landed: the player still reads 0
    expect(p.position).toBe(0);
    expect(h.c.positionMs()).toBe(30_000); // a pause written now parks the room at 30 s, not at 0
    // Two +10 s in a row before the next tick add up: the second reads the
    // first's write (the record, newer than the target still landing), not
    // the 30 s target both would otherwise start from.
    h.transport({ positionMs: h.c.positionMs() + 10_000 });
    expect(h.c.positionMs()).toBe(40_000);
    h.transport({ positionMs: h.c.positionMs() + 10_000 });
    expect(h.c.positionMs()).toBe(50_000);
    h.tick(); // followed: the newest target is what is carried to
    expect(p.log.filter((l) => l.startsWith('seek')).at(-1)).toBe('seek:50000');
    expect(h.c.positionMs()).toBe(50_000);
    p.land();
    h.tick();
    p.position = 51_000;
    expect(h.c.positionMs()).toBe(51_000); // landed: the player's clock again
    const viewer = new FakePlayer(true);
    viewer.position = 5_000;
    const hv = harness(viewer);
    hv.set({ positionMs: 40_000 });
    expect(hv.c.positionMs()).toBe(5_000); // a viewer's player is only ever where it is
  });

  it('a player with no clock (the archive embed) is played and never beats', () => {
    const p = new FakePlayer(false, false, false);
    const h = harness(p, { hold: true });
    h.set({ positionMs: 90_000 });
    h.tick();
    h.tick(TV_HEARTBEAT_MS);
    expect(p.log).toEqual(['play']);
    expect(h.beats).toEqual([]); // the headless beat keeps the room's clock for it
  });
});
