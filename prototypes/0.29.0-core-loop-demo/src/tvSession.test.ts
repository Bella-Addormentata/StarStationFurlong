/**
 * 📺 tvSession — the room tick: a holder renews on cadence, keeps the clock
 * alive headlessly only while no theatre drives it, and hands every remote
 * back when leaving.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindTvDoc, pickUpRemote, readRemote, readSample, readTv, setTvClock, setTvHostPredicate,
  setTvIdentity, tvPlay, tvSchedule, TV_HEARTBEAT_MS, TV_LEASE_RENEW_MS,
} from './tvDoc';
import {
  forgetTv, leaveTvRoom, registerTvPlayerOfRecord, setTvRoomPlayersProvider, tickTvRoom, tvRoomPlayers,
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

  it('lists the room\'s other keyed players for HAND TO', () => {
    setTvRoomPlayersProvider(() => [
      { pub: 'AAAAme', name: 'Me' }, { pub: 'BBBB', name: 'Bob' }, { pub: '', name: 'legacy' },
    ]);
    expect(tvRoomPlayers('AAAAme')).toEqual([{ pub: 'BBBB', name: 'Bob' }]);
  });
});
