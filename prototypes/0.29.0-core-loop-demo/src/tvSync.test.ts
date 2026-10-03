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
  constructor(public readonly canNudge: boolean, public readonly canSeek = true, public readonly hasClock = true) {}
  isReady() { return this.ready; }
  isPlaying() { return this.playing; }
  isEnded() { return this.ended; }
  play() { this.playing = true; this.log.push('play'); }
  pause() { this.playing = false; this.log.push('pause'); }
  /** A seek lands at once here, and un-ends the player as a <video>'s does. */
  seek(ms: number) { this.position = ms; this.ended = false; this.log.push(`seek:${ms}`); }
  currentMs() { return this.position; }
  setRate(rate: number) { this.rate = rate; this.log.push(`rate:${rate.toFixed(2)}`); }
  setVolume(v: number) { this.volume = v; }
}

function harness(player: TvPlayer, opts: { hold?: boolean; rtt?: number } = {}) {
  let now = 100_000;
  let pb: PlaybackNow = { state: 'playing', positionMs: 0, running: true, countdownMs: 0 };
  const beats: number[] = [];
  const c = new TvSyncController({
    itemId: 'tv-1',
    player,
    now: () => now,
    rttMs: () => opts.rtt ?? 0,
    iHold: () => opts.hold ?? false,
    playback: () => pb,
    heartbeat: (p) => beats.push(p),
    volume: () => 55,
  });
  return {
    c, beats,
    set: (next: Partial<PlaybackNow>) => { pb = { ...pb, ...next }; },
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
    let ended = 0;
    const c = new TvSyncController({
      itemId: 'tv-1', player: holder, now: () => now, iHold: () => true,
      playback: () => ({ state: 'playing', positionMs: pos, running: true, countdownMs: 0 }),
      heartbeat: () => undefined, volume: () => 50, onEnded: () => { ended++; },
    });
    c.tick();
    holder.position = 60_000; holder.playing = false; holder.ended = true; pos = 60_100;
    now += 500; c.tick();
    now += 500; c.tick();
    expect(ended).toBe(1);
    pos = 0; // played again from the top
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
  it('heartbeats its own player position every TV_HEARTBEAT_MS, after any remote-driven seek', () => {
    // The record follows the holder's own beats (its write lands on itself
    // at once and extrapolates from there, as readPlayback does live).
    const p = new FakePlayer(true);
    let now = 100_000;
    let sample = { positionMs: 0, receivedAt: now };
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
    // A seek written by the remote (the record jumps far): the holder's
    // player follows, and the SAME tick's beat reports the new place.
    sample = { positionMs: 60_000, receivedAt: now };
    now += TV_HEARTBEAT_MS;
    c.tick();
    expect(p.position).toBe(63_000);
    expect(beats.at(-1)).toBe(63_000);
  });

  it('does not beat while its player is still far from the record — a seek landing, or deferred by the cooldown', () => {
    const p = new FakePlayer(true);
    const h = harness(p, { hold: true });
    h.tick(); // the baseline beat, at 0
    expect(h.beats).toEqual([0]);
    h.set({ positionMs: 30_000 }); // a remote seek: the holder's player follows
    h.tick(2_600);
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000']);
    p.position = 30_000;
    h.set({ positionMs: 60_000 }); // another, inside the seek cooldown
    h.tick(500); // a beat is due, but the player is 30 s from the record and the seek deferred
    expect(p.log.filter((l) => l.startsWith('seek'))).toEqual(['seek:30000']);
    expect(h.beats).toEqual([0]); // publishing 30 000 now would undo the jump to 60 000
    h.tick(1_500); // cooldown over: the seek lands, and THAT is what goes out
    expect(p.position).toBe(60_000);
    expect(h.beats).toEqual([0, 60_000]);
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
