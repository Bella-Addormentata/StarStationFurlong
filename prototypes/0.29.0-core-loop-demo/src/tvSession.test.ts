/**
 * 📺 tvSession — the room tick: a holder renews on cadence, keeps the clock
 * alive headlessly only while no theatre drives it, and hands every remote
 * back when leaving.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindTvDoc, handRemote, iHoldRemote, pickUpRemote, putDownRemote, readRemote, readSample, readTv, setTvClock, setTvHostPredicate,
  setTvIdentity, setTvPageId, tvHeartbeat, tvPlay, tvSchedule, tvTogglePower, TV_HEARTBEAT_MS, TV_LEASE_LAPSE_MS,
  TV_LEASE_RENEW_MS,
} from './tvDoc';
import {
  armTvDrive, forgetTv, leaveTvRoom, registerTvPlayerOfRecord, setTvRoomPlayersProvider, tickTvRoom, tvDriveArmed,
  tvPlayerCanSeek, tvPlayerPositionMs, tvRoomPlayers,
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

beforeEach(() => {
  now = 5_000_000;
  setTvClock(() => now);
  setTvHostPredicate(() => false);
  setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
  bindTvDoc(new Y.Doc());
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

  it('a remote handed to my identity is claimed by the page that ticks first', () => {
    setTvIdentity(() => ({ pub: 'BBBBgiver', name: 'Giver' }));
    setTvPageId('G');
    pickUpRemote(TV);
    handRemote(TV, 'AAAAme', 'Me');
    setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
    setTvPageId('A');
    expect(iHoldRemote(TV)).toBe(false);
    tickTvRoom([TV], now);
    expect(iHoldRemote(TV)).toBe(true);
    expect(readRemote(TV)).toMatchObject({ holder: 'AAAAme', page: 'A', by: 'BBBBgiver', leaseAt: now });
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

  it('the end the holder\'s player learned travels with the remote: handed to a page that never watched, with no theatre open, the new holder still ends the programme where the media does', () => {
    setTvPageId('A');
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    const started = readTv(TV).started;
    const unregister = registerTvPlayerOfRecord(TV, { positionMs: () => 25_000, canSeek: () => true, started: () => started, endMs: () => 30_000 });
    run(1_000); // the end is noted here, and filed in the record for whoever holds the remote next
    expect(readTv(TV).endMs).toBe(30_000);
    tvHeartbeat(TV, 25_000);
    unregister();
    handRemote(TV, 'BBBBbob', 'Bob');
    // Bob's page: another identity, another page, no player of record, and
    // nothing remembered of this film — forgetTv clears what this test's
    // shared module memory knows for the set, as a fresh page knows nothing.
    setTvIdentity(() => ({ pub: 'BBBBbob', name: 'Bob' }));
    setTvPageId('B');
    forgetTv(TV);
    run(500); // Bob's first tick claims the hand-over and beats headlessly
    expect(iHoldRemote(TV)).toBe(true);
    expect(readTv(TV).state).toBe('playing'); // 25.5 s
    run(3_000);
    expect(readTv(TV).state).toBe('playing'); // 28.5 s
    run(3_000);
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null }); // past 30 s: over, from the end the record carried
  });

  it('leaving disarms the drive at once: a tick during the leave\'s flush claims and beats nothing until the next room arms it', () => {
    setTvIdentity(() => ({ pub: 'BBBBgiver', name: 'Giver' }));
    pickUpRemote(TV);
    handRemote(TV, 'AAAAme', 'Me');
    setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
    leaveTvRoom([TV]);
    expect(tvDriveArmed()).toBe(false);
    tickTvRoom([TV], now); // World keeps ticking through the awaited flush
    expect(iHoldRemote(TV)).toBe(false); // the hand-over is not claimed into a room being left
    armTvDrive(true); // the next room's docs are bound
    tickTvRoom([TV], now);
    expect(iHoldRemote(TV)).toBe(true);
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

  it('lists the room\'s other keyed players for HAND TO', () => {
    setTvRoomPlayersProvider(() => [
      { pub: 'AAAAme', name: 'Me' }, { pub: 'BBBB', name: 'Bob' }, { pub: '', name: 'legacy' },
    ]);
    expect(tvRoomPlayers('AAAAme')).toEqual([{ pub: 'BBBB', name: 'Bob' }]);
  });
});
