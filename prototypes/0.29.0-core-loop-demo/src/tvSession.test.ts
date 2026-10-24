/**
 * 📺 tvSession — the room tick: the clock's page renews on cadence, keeps
 * the clock alive headlessly only while no theatre drives it, and lets
 * every clock go when leaving.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { isTvKind, tvLabel } from './tvSession';
import {
  bindTvDoc, iHoldRemote, pickUpRemote, powerKey, putDownRemote, readPlayback, readPower, readRemote, readSample, readTv, remoteKey,
  setTvClock,
  setTvIdentity, setTvPageId, tvHeartbeat, tvKey, tvNoteEnd, tvPlay, tvSchedule, tvSetLoop, tvTogglePower, TV_HEARTBEAT_MS,
  TV_LEASE_LAPSE_MS, TV_LEASE_RENEW_MS,
} from './tvDoc';
import { TvSyncController, type TvPlayer } from './tvSync';
import {
  armTvDrive, forgetTv, leaveTvRoom, registerTvPlayerOfRecord, tickTvRoom, tvDriveArmed,
  tvPlayerCanSeek, tvPlayerPositionMs,
} from './tvSession';

const TV = 'tv-stand-1';
let now = 5_000_000;
/** The room tick as World runs it: every half second, for `ms` — the
 *  holder's renewals happen along the way, as they do live. */
const run = (ms: number, ids: readonly string[] = [TV]) => {
  for (let t = 0; t < ms; t += 500) {
    now += 500;
    tickTvRoom(ids, now);
  }
};

let bound: Y.Doc;
/** The doc beforeEach bound, for a test that syncs another page's writes into it. */
const doc0 = () => bound;

beforeEach(() => {
  now = 5_000_000;
  setTvClock(() => now);
  setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
  bindTvDoc(bound = new Y.Doc());
  leaveTvRoom([]); // the room's cadences (renewals, beats, known ends) start over with the doc
  armTvDrive(true); // the room's docs are bound: World may drive its TVs
});

describe('tickTvRoom', () => {
  it('renews a held remote every TV_LEASE_RENEW_MS and nothing when not holding', () => {
    tickTvRoom([TV], now);
    expect(readRemote(TV).holder).toBe('');
    pickUpRemote(TV);
    tickTvRoom([TV], now); // the first tick after a pick-up renews at once (a baseline)
    const first = readRemote(TV).leaseAt;
    expect(first).toBe(now);
    now += TV_LEASE_RENEW_MS - 1;
    tickTvRoom([TV], now);
    expect(readRemote(TV).leaseAt).toBe(first);
    now += 1;
    tickTvRoom([TV], now);
    expect(readRemote(TV).leaseAt).toBe(now);
  });

  it('keeps the clock alive headlessly while playing with no theatre open', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const seq0 = readTv(TV).seq;
    tickTvRoom([TV], now); // first beat is immediate
    expect(readTv(TV).seq).toBe(seq0 + 1);
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now);
    expect(readTv(TV).seq).toBe(seq0 + 2);
    expect(readTv(TV).positionMs).toBe(TV_HEARTBEAT_MS);
    expect(readSample(TV)).toMatchObject({ positionMs: TV_HEARTBEAT_MS, receivedAt: now });
  });

  it('a holder that slept beats on from where the room is: the sleep bridged on the wall clock, never the pre-sleep position', () => {
    let wall = 1_700_000_000_000;
    setTvClock(() => now, () => wall);
    const runBoth = (ms: number) => {
      for (let t = 0; t < ms; t += 500) {
        now += 500;
        wall += 500;
        tickTvRoom([TV], now);
      }
    };
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    runBoth(1_000); // ticking, beating headlessly
    const before = readTv(TV).positionMs;
    // The lid closes for an hour: the monotonic clock stands still (a 2.6 s
    // gap in the marks), the wall clock does not.
    now += 2_600;
    wall += 3_600_000;
    tickTvRoom([TV], now);
    // The hold lapsed by this page's own watch, the hour the wall clock
    // measured: picked up again, like anyone's, and the beat goes on from
    // the bridged reading, never from the pre-sleep position.
    expect(iHoldRemote(TV)).toBe(false);
    expect(readTv(TV).positionMs).toBe(before);
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    runBoth(TV_HEARTBEAT_MS);
    expect(readTv(TV).positionMs).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(readTv(TV).positionMs).toBeLessThan(before + 3_600_000 + 10_000);
  });

  it('a holder whose monotonic clock stood still through the sleep (one tick\'s worth where an hour passed — or a wall-clock step, which looks the same) lets the remote go, and picked up again beats on from where it slept: a wall delta it cannot vouch for is never added to playback', () => {
    let wall = 1_700_000_000_000;
    setTvClock(() => now, () => wall);
    const runBoth = (ms: number) => {
      for (let t = 0; t < ms; t += 500) {
        now += 500;
        wall += 500;
        tickTvRoom([TV], now);
      }
    };
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    runBoth(1_000);
    const before = readTv(TV).positionMs;
    now += 500; // no gap by this clock at all
    wall += 3_600_000;
    tickTvRoom([TV], now);
    expect(iHoldRemote(TV)).toBe(false); // lapsed by the hour the wall clock measured, not renewed over a takeover
    expect(readTv(TV).positionMs).toBe(before);
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    runBoth(TV_HEARTBEAT_MS);
    // The ambiguous hour is not in the beat: the room is not jumped forward on
    // the wall clock's word (a step while awake would jump everyone), the
    // cost being a rejoin where it slept when the hour was a real sleep.
    expect(readTv(TV).positionMs).toBeGreaterThanOrEqual(before);
    expect(readTv(TV).positionMs).toBeLessThan(before + 10_000);
  });

  it('flips a scheduled programme to playing at T0 the way the theatre would', () => {
    pickUpRemote(TV);
    tvSchedule(TV, { kind: 'url', url: 'https://example.org/a.mp4' }, now + 60_000);
    run(30_000);
    expect(readTv(TV).state).toBe('scheduled');
    run(29_000); // to T0 − 1 s, the lease renewed along the way
    now += 1_500; // T0 + 0.5 s
    tickTvRoom([TV], now);
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 500 });
  });

  it('defers to a registered player of record', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const seq0 = readTv(TV).seq;
    const unregister = registerTvPlayerOfRecord(TV);
    tickTvRoom([TV], now);
    expect(readTv(TV).seq).toBe(seq0);
    unregister();
    tickTvRoom([TV], now + 1);
    expect(readTv(TV).seq).toBe(seq0 + 1);
  });

  it('leaving puts every held remote back on the set', () => {
    pickUpRemote(TV);
    pickUpRemote('tv-2');
    leaveTvRoom([TV, 'tv-2', 'tv-3']);
    expect(readRemote(TV).holder).toBe('');
    expect(readRemote('tv-2').holder).toBe('');
  });

  it('a removed set takes this client\'s hold on its remote with it', () => {
    pickUpRemote(TV);
    pickUpRemote('tv-2');
    forgetTv(TV);
    expect(readRemote(TV).holder).toBe('');
    expect(readRemote('tv-2').holder).toBe('AAAAme');
    forgetTv('tv-9'); // never held: nothing to do
  });

  it('a second tab of the same identity neither renews nor releases the first tab\'s remote', () => {
    setTvPageId('A');
    pickUpRemote(TV);
    tickTvRoom([TV], now);
    const lease = readRemote(TV).leaseAt;
    setTvPageId('B'); // the same key in another tab
    now += TV_LEASE_RENEW_MS;
    tickTvRoom([TV], now);
    expect(readRemote(TV).leaseAt).toBe(lease);
    leaveTvRoom([TV]);
    forgetTv(TV);
    expect(readRemote(TV)).toMatchObject({ holder: 'AAAAme', page: 'A' });
  });

  it('tells the phone where the live player is and whether it can seek, and nothing when none is mounted', () => {
    expect(tvPlayerPositionMs(TV)).toBeNull();
    expect(tvPlayerCanSeek(TV)).toBeNull();
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 12_345, canSeek: () => false });
    expect(tvPlayerPositionMs(TV)).toBe(12_345);
    expect(tvPlayerCanSeek(TV)).toBe(false);
    unregister();
    expect(tvPlayerPositionMs(TV)).toBeNull();
  });

  it('POWER back on parks a programme that was playing when the set went off — the holder\'s write, where it was, as the switch is seen', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now); // the baseline beat
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now); // at 3 s
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: TV_HEARTBEAT_MS });
    setTvIdentity(() => ({ pub: 'BBBBviewer', name: 'Viewer' })); // anyone may press the body button
    expect(tvTogglePower(TV)).toBe(false);
    setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
    run(60_000); // off for a minute, the holder still here: no beat, the programme untouched
    expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: TV_HEARTBEAT_MS });
    tvTogglePower(TV);
    // Parked on the holder's page as the switch's write lands — before the
    // theatre's controller (400 ms on its own) or this room tick (500 ms)
    // could seek to a sample extrapolated across the minute off and beat
    // that over the saved position: such a beat is refused from here on.
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS });
    expect(tvHeartbeat(TV, TV_HEARTBEAT_MS + 60_000)).toEqual({ ok: false, error: 'Nothing is playing.' });
    tickTvRoom([TV], now + 500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS });
  });

  it('the park lands where the room was switched off by the presser\'s reading, not at a heartbeat the holder\'s sleep left behind', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now); // the baseline beat, at 0
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now); // at 3 s
    now += 20_000; // the holder's page sleeps: no tick, no beat, while the film plays on for everyone
    setTvIdentity(() => ({ pub: 'BBBBviewer', name: 'Viewer' }));
    run(1_000); // a viewer's page, awake and ticking (it holds nothing: no beat)
    expect(tvTogglePower(TV)).toBe(false); // the viewer switches off: the room read 24 s
    const off = TV_HEARTBEAT_MS + 21_000;
    expect(readPower(TV).parkMs).toBe(off);
    expect(readTv(TV).positionMs).toBe(TV_HEARTBEAT_MS); // the record itself still says 3 s
    run(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true); // the viewer switches on: the lapsed remote is theirs, and so is the park
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: off }); // where it was switched off, not 3 s
    run(500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: off });
  });

  it('a park at the start is honoured: switched off at 0, the holder parks at 0 and not at a minute in', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now); // the baseline beat, at 0
    expect(tvTogglePower(TV)).toBe(false); // the same instant: the room reads 0, a reading
    expect(readPower(TV).parkMs).toBe(0);
    run(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 0 });
    run(500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 0 });
  });

  it('a switch that carries no reading — the presser\'s was stale (tvDoc) — parks the programme at the record\'s last beat: behind the room by a beat at most, never ahead', () => {
    const doc = new Y.Doc();
    bindTvDoc(doc);
    leaveTvRoom([]);
    armTvDrive(true);
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now); // the baseline beat, at 0
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now); // at 3 s
    now += 1_000; // the room at 4 s
    // Another page's OFF, carrying no reading: its own was stale.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getMap('tv').set(powerKey(TV), { on: false, seq: readPower(TV).seq + 1, parkMs: null });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(readTv(TV).state).toBe('off');
    run(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true); // the holder, this page, switches on
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS }); // the last beat: 3 s, not 64 s
    run(500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS });
  });

  it('POWER back on parks a schedule past T0 where it was switched off — playing by the clock, its record never flipped — not at the time since T0 with the minute off counted; a schedule that started while the set was off carries no reading and plays from the clock', () => {
    const clip = { kind: 'url' as const, url: 'https://example.org/a.mp4' };
    pickUpRemote(TV);
    tvSchedule(TV, clip, now + 10_000);
    putDownRemote(TV); // the scheduler leaves: past T0 the room free-runs from the UTC start, the record never flipped
    run(12_000);
    expect(readTv(TV).state).toBe('scheduled');
    expect(readPlayback(TV, now)).toMatchObject({ state: 'playing', positionMs: 2_000 });
    expect(tvTogglePower(TV)).toBe(false); // the room read 2 s
    expect(readPower(TV).parkMs).toBe(2_000);
    run(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true); // the free remote is the presser's, and so is the park
    expect(readTv(TV)).toMatchObject({ state: 'paused', startAt: 0, positionMs: 2_000 }); // where it was switched off, not 62 s in
    run(500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 2_000 });
    // A countdown switched off and on: nothing to carry, nothing parked — a
    // schedule that started meanwhile plays from the clock's reading at the
    // holder's first tick past T0, as a room whose remote lapsed does.
    expect(tvSchedule(TV, clip, now + 10_000)).toEqual({ ok: true });
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV).parkMs).toBeNull();
    run(12_000); // T0 passes while the set is off
    expect(tvTogglePower(TV)).toBe(true);
    expect(readTv(TV).state).toBe('scheduled'); // nothing to park at
    run(500); // the holder's headless beat flips it, at the time since T0
    expect(readTv(TV)).toMatchObject({ state: 'playing', startAt: 0, positionMs: 2_500 });
  });

  it('POWER back on with a free remote: the presser takes the remote and parks the programme where it was; a flip nobody could park waits for the first holder', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now);
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now); // at 3 s
    putDownRemote(TV); // the holder leaves the remote on the set
    expect(tvTogglePower(TV)).toBe(false);
    run(60_000); // off for a minute, nobody holding
    expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: TV_HEARTBEAT_MS });
    setTvIdentity(() => ({ pub: 'BBBBviewer', name: 'Viewer' }));
    expect(tvTogglePower(TV)).toBe(true); // the viewer turns it on: the remote is theirs, and so is the park
    expect(readRemote(TV)).toMatchObject({ holder: 'BBBBviewer' });
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS });
    tickTvRoom([TV], now + 500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS });
    // A flip seen before anyone holds the remote is owed until someone does.
    now += 1_000;
    tvPlay(TV, { kind: 'url', url: 'https://example.org/b.mp4' }); // the viewer, holding, plays on
    tickTvRoom([TV], now);
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now);
    const at = readTv(TV).positionMs; // where the second film stands as the set goes off
    putDownRemote(TV);
    tvTogglePower(TV); // off
    run(60_000);
    setTvIdentity(() => ({ pub: '', name: '' })); // a page with no identity yet picks nothing up
    expect(tvTogglePower(TV)).toBe(true);
    expect(readRemote(TV).holder).toBe('');
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: at }); // nobody to park it yet
    setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
    pickUpRemote(TV); // the first to pick it up parks it where it stood…
    tickTvRoom([TV], now + 1_000);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: at }); // …not where a minute's extrapolation would put it
  });

  it('a holder who closes the theatre still ends a finite programme where the media ends: the headless beat remembers the end', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const started = readTv(TV).started;
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 25_000, canSeek: () => true, started: () => started, endMs: () => 30_000 });
    run(1_000); // the theatre's player is the room's clock: where its media ends is noted, and confirmed on the second tick
    tvHeartbeat(TV, 25_000); // the theatre's beat
    unregister(); // the holder closes the theatre at 25 s; the record runs on headlessly
    run(3_000);
    expect(readTv(TV).state).toBe('playing'); // 28 s: not over yet
    run(3_000);
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null }); // 31 s: over, once, as the controller would have ended it
    expect(readTv(TV).history).toHaveLength(1); // the film kept in PREVIOUSLY ON
    // A live stream has no end to remember: it runs on.
    tvPlay(TV, { kind: 'url', url: 'https://example.org/live.m3u8' });
    const unregisterLive = registerTvPlayerOfRecord(TV, { positionMs: () => 0, canSeek: () => false, endMs: () => null });
    run(1_000);
    unregisterLive();
    run(60_000);
    expect(readTv(TV).state).toBe('playing');
  });

  it('with LOOP on, the headless beat starts the programme over at the end it carries, lap after lap; LOOP off, the next end is home', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const first = readTv(TV).started;
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 25_000, canSeek: () => true, started: () => first, endMs: () => 30_000 });
    run(1_000);
    tvHeartbeat(TV, 25_000);
    unregister(); // the holder closes the theatre at 25 s; the record runs on headlessly
    tvSetLoop(TV, true);
    run(6_000); // 31 s: past the end
    expect(readTv(TV)).toMatchObject({ state: 'playing', endMs: 30_000, started: first + 1 });
    expect(readPlayback(TV, now).positionMs).toBeLessThan(TV_HEARTBEAT_MS); // from the top
    run(30_000); // the second lap ends on the end the record kept: no player was needed to know it
    expect(readTv(TV)).toMatchObject({ state: 'playing', started: first + 2 });
    expect(readTv(TV).history).toHaveLength(1); // one showing, however many laps
    tvSetLoop(TV, false);
    run(31_000);
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null });
  });

  it('picked up in an empty room on LOOP, the headless beat takes the room on from the lap it is on, not from the top', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tvSetLoop(TV, true);
    tvNoteEnd(TV, 60_000);
    tvHeartbeat(TV, 50_000);
    putDownRemote(TV); // the holder leaves: nobody runs the laps
    const started = readTv(TV).started;
    now += 100_000; // 150 s of a 60 s film: 30 s into its third lap
    setTvPageId('B');
    setTvIdentity(() => ({ pub: 'BBBBbob', name: 'Bob' }));
    pickUpRemote(TV); // from the phone, no theatre open
    tickTvRoom([TV], now);
    expect(readTv(TV)).toMatchObject({ state: 'playing', started, positionMs: 30_000 });
    run(3_000);
    expect(readTv(TV)).toMatchObject({ state: 'playing', started });
    expect(readPlayback(TV, now).positionMs).toBe(33_000);
  });

  it('a clip that laps on every theatre tick still has its end filed, so the headless beat loops it on once the theatre closes', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/blip.mp4' });
    tvSetLoop(TV, true);
    const DUR = 300; // shorter than the theatre's 400 ms tick
    let pos = 0;
    let playing = false;
    let last = now;
    const player: TvPlayer = {
      canNudge: true, canSeek: true, hasClock: true,
      isReady: () => true, isPlaying: () => playing, isEnded: () => pos >= DUR,
      play: () => { playing = true; }, pause: () => { playing = false; },
      seek: (ms) => { pos = Math.min(Math.max(0, ms), DUR); },
      currentMs: () => pos, seekableRange: () => ({ startMs: 0, endMs: DUR }),
      setRate: () => {}, setVolume: () => {},
    };
    // The theatre: its registration names the programme its tick last saw,
    // and a lap its controller followed as the clip ended.
    let playerFor = readTv(TV).started;
    let metadata = false; // the length arrives with the media's metadata, after the mount
    const c = new TvSyncController({ itemId: TV, player, now: () => now, onLapFollowed: (started) => { playerFor = started; } });
    const unregister = registerTvPlayerOfRecord(TV, {
      positionMs: () => c.positionMs(), canSeek: () => true, started: () => playerFor, endMs: () => (metadata ? DUR : null),
    });
    const first = readTv(TV).started;
    // The theatre's 400 ms tick and World's 500 ms room tick, interleaved:
    // the clip laps on every theatre tick, the first before any room tick.
    for (let ms = 0; ms <= 4_000; ms += 100) {
      now += 100;
      if (playing) pos = Math.min(DUR, pos + (now - last));
      last = now;
      if (ms % 400 === 0) {
        playerFor = readTv(TV).started;
        c.tick();
      }
      if (ms % 500 === 0) tickTvRoom([TV], now);
      metadata = true;
    }
    expect(readTv(TV).started).toBeGreaterThan(first + 5); // it laps
    expect(readTv(TV).endMs).toBe(DUR); // and its end is in the record
    unregister(); // the holder closes the theatre
    const closed = readTv(TV).started;
    run(2_000);
    expect(readTv(TV)).toMatchObject({ state: 'playing' });
    expect(readTv(TV).started).toBeGreaterThan(closed); // the headless beat laps it on its end
  });

  it('an end reported by a player mounted for a programme that has moved on is not filed under the new one', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/short.mp4' });
    const first = readTv(TV).started;
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 1_000, canSeek: () => true, started: () => first, endMs: () => 30_000 });
    run(1_000); // the short film's end, confirmed
    tvPlay(TV, { kind: 'url', url: 'https://example.org/live.m3u8' }); // the record moves on; the theatre has not remounted yet
    run(1_000); // room ticks in that gap: the old player's length is not the new programme's
    unregister(); // the theatre tears the old player down, and the holder closes it
    run(120_000);
    expect(readTv(TV).state).toBe('playing'); // never stopped at the short film's length
  });

  it('an end that moves within one programme — a live event\'s elapsed time, repeating between polls before it grows — unbounds the programme for good', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/live.m3u8' });
    const started = readTv(TV).started;
    // What a player that cannot tell live from finite might report: the
    // same value twice (an asynchronously updated reading), then more.
    const readings = [30_000, 30_000, 30_500, 30_500, 31_000, 31_000];
    let i = 0;
    const unregister = registerTvPlayerOfRecord(TV, {
      positionMs: () => 29_000, canSeek: () => false, started: () => started, endMs: () => readings[Math.min(i++, readings.length - 1)]!,
    });
    run(3_000);
    unregister(); // the holder closes the theatre: the clock runs on headlessly, past every value ever read
    run(120_000);
    expect(readTv(TV).state).toBe('playing');
  });

  it('the end a player learned just before the theatre closed is kept: a close before the next tick still ends the programme', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const started = readTv(TV).started;
    let end: number | null = null; // before the metadata: unknown
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 25_000, canSeek: () => true, started: () => started, endMs: () => end });
    run(1_000); // the room ticks while the player knows nothing yet
    end = 30_000; // the metadata lands…
    tvHeartbeat(TV, 25_000); // the theatre's beat
    unregister(); // …and the holder closes the theatre before the next tick
    run(3_000);
    expect(readTv(TV).state).toBe('playing'); // 28 s
    run(3_000);
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null }); // 31 s: over where the media ended
  });

  it('an unknown reading between finite reports forgets neither a finite end nor the unbounded marker', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/live.m3u8' });
    const started = readTv(TV).started;
    // An end that moved (unbounded from then on), a remount's unknown
    // reading, then a finite value again: still unbounded.
    const moving: Array<number | null> = [30_000, 30_500, null, 31_000, 31_000, 31_000];
    let i = 0;
    const unregister = registerTvPlayerOfRecord(TV, {
      positionMs: () => 29_000, canSeek: () => false, started: () => started, endMs: () => moving[Math.min(i++, moving.length - 1)]!,
    });
    run(3_000);
    unregister();
    run(120_000);
    expect(readTv(TV).state).toBe('playing');
    // A finite end, an unknown reading (the same file remounting), the same
    // finite end: the end is kept, and the close still ends the programme.
    expect(tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' })).toEqual({ ok: true });
    const second = readTv(TV).started;
    const steady: Array<number | null> = [30_000, null, 30_000];
    let j = 0;
    const unregisterSteady = registerTvPlayerOfRecord(TV, {
      positionMs: () => 25_000, canSeek: () => true, started: () => second, endMs: () => steady[Math.min(j++, steady.length - 1)]!,
    });
    run(1_500);
    tvHeartbeat(TV, 25_000);
    unregisterSteady();
    run(6_000);
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null });
  });

  it('the end the clock page\'s player learned travels with the record: taken by a press on a page that never watched, with no theatre open, the new clock page still ends the programme where the media does', () => {
    setTvPageId('A');
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const started = readTv(TV).started;
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 25_000, canSeek: () => true, started: () => started, endMs: () => 30_000 });
    run(1_000); // the end is noted here, and filed in the record for whoever holds the remote next
    expect(readTv(TV).endMs).toBe(30_000);
    tvHeartbeat(TV, 25_000);
    unregister();
    // Bob's page: another identity, another page, no player of record, and
    // nothing remembered of this film — forgetTv clears what this test's
    // shared module memory knows for the set, as a fresh page knows nothing.
    setTvIdentity(() => ({ pub: 'BBBBbob', name: 'Bob' }));
    setTvPageId('B');
    forgetTv(TV);
    pickUpRemote(TV); // Bob presses on his phone: the clock is his page's
    run(500); // and his tick beats headlessly
    expect(iHoldRemote(TV)).toBe(true);
    expect(readTv(TV).state).toBe('playing'); // 25.5 s
    run(3_000);
    expect(readTv(TV).state).toBe('playing'); // 28.5 s
    run(3_000);
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null }); // past 30 s: over, from the end the record carried
  });

  it('an end the player learned just before its theatre went is filed in the record at once: a press elsewhere before the next tick still carries it', () => {
    setTvPageId('A');
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const started = readTv(TV).started;
    run(500); // a tick with no player yet: nothing known of the end
    expect(readTv(TV).endMs).toBe(0);
    // The metadata lands and the player goes in the same breath, with no
    // room tick between — then someone else presses before the next.
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 5_000, canSeek: () => true, started: () => started, endMs: () => 30_000 });
    unregister();
    expect(readTv(TV).endMs).toBe(30_000); // filed as it went, while this page still kept the clock
    setTvIdentity(() => ({ pub: 'BBBBbob', name: 'Bob' }));
    setTvPageId('B');
    forgetTv(TV); // Bob's page knows nothing of the film…
    pickUpRemote(TV); // …and presses
    run(500);
    expect(iHoldRemote(TV)).toBe(true);
    run(30_000); // …and still ends it where the record says
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null });
  });

  it('an OFF and an ON that arrive in one merged update are a power cycle too: the holder parks where the room was switched off', () => {
    const doc = new Y.Doc();
    bindTvDoc(doc);
    leaveTvRoom([]);
    armTvDrive(true);
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const started = readTv(TV).started;
    tickTvRoom([TV], now); // the baseline beat, at 0 — and the switch seen ON
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now); // at 3 s
    // The holder's theatre is open: its player is the room's clock and would
    // beat its own position over any anchor the switch carried.
    let position = 4_000;
    registerTvPlayerOfRecord(TV, { positionMs: () => position, canSeek: () => true, started: () => started, endMs: () => null });
    // Another page switched the set OFF at 4 s and, a minute later, ON —
    // and this page receives both writes in ONE update (a catch-up after a
    // hiccup): the observer sees only the final ON, `on` unchanged.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const seq = readPower(TV).seq;
    other.transact(() => {
      other.getMap('tv').set(powerKey(TV), { on: false, seq: seq + 1, parkMs: 4_000 });
      other.getMap('tv').set(powerKey(TV), { on: true, seq: seq + 2, parkMs: 4_000 });
    });
    run(60_000); // the minute passes HERE with the holder ticking and renewing (it never saw the OFF)
    position = 64_000; // the holder's player ran on through it, as a <video> does
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    expect(readPower(TV)).toMatchObject({ on: true, seq: seq + 2, parkMs: 4_000 });
    expect(iHoldRemote(TV)).toBe(true);
    run(500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 4_000 }); // parked where it was switched off, not 64 s
  });

  it('POWER ON arriving merged with a replacement programme owes no park: the new film is not paused by whoever takes the remote next', () => {
    const doc = new Y.Doc();
    bindTvDoc(doc);
    leaveTvRoom([]);
    armTvDrive(true);
    setTvPageId('A');
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now); // the switch seen ON, the first film running
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now);
    // Another page: OFF at 3 s, then — the remote lapsed from here — picks
    // it up, switches ON and PLAY NOWs a second film; this page receives
    // the whole sequence in ONE update, the switch and the new programme
    // together. Written here as the raw records that page's writes leave.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const seq = readPower(TV).seq;
    const rec = other.getMap('tv').get(tvKey(TV)) as Record<string, unknown>;
    other.transact(() => {
      other.getMap('tv').set(powerKey(TV), { on: false, seq: seq + 1, parkMs: 3_000 });
      other.getMap('tv').set(powerKey(TV), { on: true, seq: seq + 2, parkMs: 3_000 });
      other.getMap('tv').set(tvKey(TV), {
        ...rec, source: { kind: 'url', url: 'https://example.org/b.mp4' }, state: 'playing', positionMs: 0,
        seq: (rec.seq as number) + 1, started: (rec.started as number) + 1, jump: (rec.jump as number) + 1,
      });
      other.getMap('tv').set(remoteKey(TV), { holder: 'BBBBbob', name: 'Bob', leaseAt: 1, by: 'BBBBbob', page: 'B' });
    });
    run(60_000); // this page ticks on through the minute; its own lease lapses by its own watch, as the other page saw
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    expect(readTv(TV)).toMatchObject({ state: 'playing', source: { url: 'https://example.org/b.mp4' } });
    run(TV_LEASE_LAPSE_MS + 1_000); // Bob's lease, seen just now, lapses by this page's watch…
    expect(pickUpRemote(TV)).toEqual({ ok: true }); // …and this page takes the remote
    run(500);
    expect(readTv(TV).state).toBe('playing'); // the new film runs on: no park was owed to it
    expect(readTv(TV).source).toMatchObject({ url: 'https://example.org/b.mp4' });
  });

  it('a press on waking takes the room from a peer\'s wake-window beat as it landed, never bridged across the sleep: no beat an hour ahead, no programme closed on the spot', () => {
    let wall = 1_700_000_000_000;
    setTvClock(() => now, () => wall);
    const step = (ms: number) => { now += ms; wall += ms; };
    setTvPageId('A');
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    expect(tvNoteEnd(TV, 30_000)).toEqual({ ok: true }); // the film is 30 s long, says the record
    setTvIdentity(() => ({ pub: 'BBBBbob', name: 'Bob' }));
    setTvPageId('B');
    pickUpRemote(TV); // Bob presses, and beats from his own page
    setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
    setTvPageId('A');
    tickTvRoom([TV], now); // this page: a viewer, awake
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc0()));
    const bobBeats = (positionMs: number) => {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc0(), Y.encodeStateVector(other)));
      const rec = other.getMap('tv').get(tvKey(TV)) as Record<string, unknown>;
      other.getMap('tv').set(tvKey(TV), { ...rec, positionMs, seq: (rec.seq as number) + 1 });
      Y.applyUpdate(doc0(), Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc0())));
    };
    bobBeats(5_000);
    step(500);
    tickTvRoom([TV], now);
    expect(readPlayback(TV, now)).toMatchObject({ positionMs: 5_500 });
    // This page sleeps an hour (the monotonic clock ran on; the wall clock
    // agrees, so the bridge adds nothing). The first tick back finds the gap.
    step(3_600_000);
    tickTvRoom([TV], now);
    // In the moment after waking, Bob's latest beat lands: he is at 12 s.
    // Stamped from before the gap, it reads an hour ahead — and stale.
    step(200);
    bobBeats(12_000);
    const woke = readPlayback(TV, now);
    expect(woke.stale).toBe(true);
    expect(woke.positionMs).toBeGreaterThan(3_600_000); // the bridged reading: shown, never acted on by a viewer
    expect(woke.anchorMs).toBe(12_000); // the takeover anchor: where Bob's beat was as it landed
    // Bob's lease, seen last before the sleep, has lapsed by this page's
    // watch: this page picks the remote up and beats headlessly.
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    run(500);
    expect(readTv(TV).state).toBe('playing'); // not closed as "past 30 s"
    expect(readTv(TV).positionMs).toBeGreaterThanOrEqual(12_000);
    expect(readTv(TV).positionMs).toBeLessThan(13_500); // the beat from the anchor, not from an hour ahead
  });

  it('leaving disarms the drive at once: a tick during the leave\'s flush renews and beats nothing until the next room arms it', () => {
    const SET = 'tv-left-behind'; // a set no other test mounted a player on
    pickUpRemote(SET);
    tvPlay(SET, { kind: 'url', url: 'https://example.org/a.mp4' });
    leaveTvRoom([SET]);
    expect(tvDriveArmed()).toBe(false);
    expect(readRemote(SET).holder).toBe(''); // the clock let go
    pickUpRemote(SET); // a press on the phone mid-leave
    const lease = readRemote(SET).leaseAt;
    const seq = readTv(SET).seq;
    run(TV_LEASE_RENEW_MS, [SET]); // World keeps ticking through the awaited flush
    expect(readRemote(SET).leaseAt).toBe(lease);
    expect(readTv(SET).seq).toBe(seq); // no renewal, and no beat into a room being left
    armTvDrive(true); // the next room's docs are bound
    run(500, [SET]);
    expect(readRemote(SET).leaseAt).toBe(now);
    expect(readTv(SET).seq).not.toBe(seq);
  });

  it('a holder tab suspended past the lapse does not renew on waking: the room tick finds no remote of its own', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now);
    const lease = readRemote(TV).leaseAt;
    const seq = readTv(TV).seq;
    now += TV_LEASE_LAPSE_MS + 60_000; // a closed lid: no ticks, no renewals
    tickTvRoom([TV], now);
    expect(readRemote(TV).leaseAt).toBe(lease); // the expired claim is not renewed…
    expect(readTv(TV).seq).toBe(seq); // …and the headless beat stays silent: not this page's clock any more
    expect(iHoldRemote(TV)).toBe(false);
  });
});

describe('the TV kinds, in one place', () => {
  it('names both sets and nothing else, and labels each for the panels, the chip and the theatre', () => {
    expect(isTvKind('smart-tv')).toBe(true);
    expect(isTvKind('tv-stand')).toBe(true);
    expect(isTvKind('wall-computer')).toBe(false);
    expect(isTvKind(undefined)).toBe(false);
    expect(tvLabel('tv-stand')).toBe('TV ON THE STAND');
    expect(tvLabel('smart-tv')).toBe('WALL TV');
    expect(tvLabel(undefined)).toBe('WALL TV'); // a set whose record is gone still has a name on the chip
  });
});
