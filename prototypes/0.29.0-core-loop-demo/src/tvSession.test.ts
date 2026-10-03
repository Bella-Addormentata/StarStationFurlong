/**
 * 📺 tvSession — the room tick: a holder renews on cadence, keeps the clock
 * alive headlessly only while no theatre drives it, and hands every remote
 * back when leaving.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindTvDoc, handRemote, iHoldRemote, pickUpRemote, readRemote, readSample, readTv, setTvClock, setTvHostPredicate,
  setTvIdentity, setTvPageId, tvPlay, tvSchedule, tvTogglePower, TV_HEARTBEAT_MS, TV_LEASE_RENEW_MS,
} from './tvDoc';
import {
  forgetTv, leaveTvRoom, registerTvPlayerOfRecord, setTvRoomPlayersProvider, tickTvRoom, tvPlayerCanSeek,
  tvPlayerPositionMs, tvRoomPlayers,
} from './tvSession';

const TV = 'tv-stand-1';
let now = 5_000_000;

beforeEach(() => {
  now = 5_000_000;
  setTvClock(() => now);
  setTvHostPredicate(() => false);
  setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
  bindTvDoc(new Y.Doc());
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
    tickTvRoom([TV], now + 30_000);
    expect(readTv(TV).state).toBe('scheduled');
    now += 60_500;
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

  it('POWER back on parks a programme that was playing when the set went off — the holder\'s write, where it was', () => {
    pickUpRemote(TV);
    tvPlay(TV, { kind: 'url', url: 'https://example.org/a.mp4' });
    tickTvRoom([TV], now); // the baseline beat
    now += TV_HEARTBEAT_MS;
    tickTvRoom([TV], now); // at 3 s
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: TV_HEARTBEAT_MS });
    setTvIdentity(() => ({ pub: 'BBBBviewer', name: 'Viewer' })); // anyone may press the body button
    expect(tvTogglePower(TV)).toBe(false);
    setTvIdentity(() => ({ pub: 'AAAAme', name: 'Me' }));
    now += 60_000;
    tickTvRoom([TV], now); // off: no beat, the programme untouched
    expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: TV_HEARTBEAT_MS });
    tvTogglePower(TV);
    tickTvRoom([TV], now + 500);
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: TV_HEARTBEAT_MS });
  });

  it('lists the room\'s other keyed players for HAND TO', () => {
    setTvRoomPlayersProvider(() => [
      { pub: 'AAAAme', name: 'Me' }, { pub: 'BBBB', name: 'Bob' }, { pub: '', name: 'legacy' },
    ]);
    expect(tvRoomPlayers('AAAAme')).toEqual([{ pub: 'BBBB', name: 'Bob' }]);
  });
});
