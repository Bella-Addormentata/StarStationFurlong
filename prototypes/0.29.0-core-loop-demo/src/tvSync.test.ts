/**
 * 📺 tvSync — the controller against a fake player and a fake clock: a
 * viewer seeks when far, nudges when near, and leaves a YouTube-shaped player
 * alone inside the band; the holder heartbeats from its own player; a
 * scheduled programme parks at 0 and starts at T0; a paused one holds.
 */
import { describe, expect, it } from 'vitest';
import { TvSyncController, TV_SEEK_COOLDOWN_MS } from './tvSync';
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
  /** The media's length: where a seek is clamped (a player knows its end
   *  before it can say so), and what durationMs() reports when `reportsDuration`. */
  duration = NaN;
  reportsDuration = true;
  private pendingSeek: number | null = null;
  constructor(public readonly canNudge: boolean, public readonly canSeek = true, public readonly hasClock = true) {}
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
    const end = Number.isFinite(this.duration) ? this.duration : Infinity;
    this.position = Math.min(ms, end);
    this.ended = this.position >= end;
  }
  currentMs() { return this.position; }
  durationMs() { return this.reportsDuration ? this.duration : NaN; }
  setRate(rate: number) { this.rate = rate; this.log.push(`rate:${rate.toFixed(2)}`); }
  setVolume(v: number) { this.volume = v; }
}

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
    p.reportsDuration = false; // YouTube before its metadata: nothing to clamp to
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
