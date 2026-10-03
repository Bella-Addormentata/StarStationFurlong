/**
 * 📺 tvDoc — the TV's records against a real Y.Doc: the remote as
 * possession (pick up, hand over, put down, lapse, the owner's spare), the
 * holder-gated programme writes, the shape-checked reads that survive a
 * peer's garbage, and the sync maths that never compares two clocks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindTvDoc, claimRemote, countdownText, driftAction, expectedPositionMs, formatClock, handRemote, iHoldRemote, isStartOnly,
  mayPickUpRemote, parseTvSource, pickUpRemote, putDownRemote, readPlayback, readPower, readProgramme, readRemote,
  readSample, readTv, remoteKey, remoteStatus, renewRemote, sanitizeSource, setTvClock,
  setTvHostPredicate, setTvIdentity, setTvPageId, sourceFileUrl, sourceLabel, subscribeTvKey, tvHeartbeat,
  tvKey, tvPause, tvPlay, tvResume, tvSchedule, tvScreenView, tvSeek, tvSetVolume, tvStop,
  tvTogglePower, TV_COUNTER_MAX, TV_HEARTBEAT_MS, TV_HISTORY_MAX, TV_LEASE_LAPSE_MS, TV_RTT_LEAD_CAP_MS,
  TV_SEEK_OVER_MS, powerKey, tvRevision, volumeKey,
} from './tvDoc';
import type { TvSource } from './tvDoc';

const TV = 'smart-tv-1';
const ALICE = 'AAAAalicepub';
const BOB = 'BBBBbobpub';
const FILM: TvSource = { kind: 'youtube', videoId: 'uPwPecwX2zs', title: 'Metropolis' };
const CLIP: TvSource = { kind: 'url', url: 'https://example.org/clip.mp4' };

let doc: Y.Doc;
let now = 1_000_000;
const iAm = (pub: string, name = pub.slice(4, 9)) => setTvIdentity(() => ({ pub, name }));
const tick = (ms: number) => { now += ms; };

beforeEach(() => {
  doc = new Y.Doc();
  now = 1_000_000;
  setTvClock(() => now);
  setTvHostPredicate(() => false);
  setTvPageId('A');
  bindTvDoc(doc);
  iAm(ALICE, 'Alice');
});

describe('the remote as possession', () => {
  it('starts on the set, and anyone may pick it up', () => {
    expect(remoteStatus(TV)).toBe('free');
    expect(mayPickUpRemote(TV)).toBe(true);
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    expect(iHoldRemote(TV)).toBe(true);
    expect(readRemote(TV)).toEqual({ holder: ALICE, name: 'Alice', leaseAt: now, by: ALICE, page: 'A' });
  });

  it('is refused to a second player while the holder keeps renewing', () => {
    pickUpRemote(TV);
    iAm(BOB, 'Bob');
    expect(remoteStatus(TV)).toBe('held');
    expect(pickUpRemote(TV)).toEqual({ ok: false, error: 'Alice is holding the remote.' });
    expect(tvPlay(TV, FILM)).toEqual({ ok: false, error: 'Alice has the remote.' });
  });

  it('lapses by the renewals THIS page saw, never by the holder\'s clock', () => {
    pickUpRemote(TV);
    iAm(BOB, 'Bob');
    tick(TV_LEASE_LAPSE_MS - 1);
    expect(remoteStatus(TV)).toBe('held');
    tick(1);
    expect(remoteStatus(TV)).toBe('free');
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    expect(readRemote(TV).holder).toBe(BOB);
  });

  it('a renewal restarts the lapse clock', () => {
    pickUpRemote(TV);
    tick(TV_LEASE_LAPSE_MS - 1000);
    renewRemote(TV);
    iAm(BOB);
    tick(2000);
    expect(remoteStatus(TV)).toBe('held');
  });

  it('a holder claiming a far-future lease still lapses here on time', () => {
    // A peer writing the map directly, with a clock a day ahead.
    doc.getMap('tv').set(remoteKey(TV), { holder: BOB, name: 'Bob', leaseAt: now + 86_400_000 });
    expect(remoteStatus(TV)).toBe('held');
    tick(TV_LEASE_LAPSE_MS);
    expect(remoteStatus(TV)).toBe('free');
  });

  it('hands over without an accept step, and only the holder may', () => {
    pickUpRemote(TV);
    expect(handRemote(TV, BOB, 'Bob')).toEqual({ ok: true });
    // `by` names the GIVER: Bob's phone can tell a hand-over from his own pick-up.
    expect(readRemote(TV)).toEqual({ holder: BOB, name: 'Bob', leaseAt: now, by: ALICE, page: '' });
    expect(iHoldRemote(TV)).toBe(false);
    // Alice no longer holds it; she may not hand it on to a third player.
    expect(handRemote(TV, 'CCCCcarolpub', 'Carol')).toEqual({ ok: false, error: 'You are not holding the remote.' });
    // Bob may not hand it to himself.
    iAm(BOB, 'Bob');
    expect(handRemote(TV, BOB, 'Bob')).toEqual({ ok: false, error: 'Pick someone else.' });
  });

  it('goes back on the set when put down, and only the holder may', () => {
    pickUpRemote(TV);
    iAm(BOB);
    expect(putDownRemote(TV)).toEqual({ ok: false, error: 'Alice is holding the remote.' });
    iAm(ALICE);
    expect(putDownRemote(TV)).toEqual({ ok: true });
    expect(remoteStatus(TV)).toBe('free');
  });

  it('the owner has the spare: may take it from anyone, hand it, or put it down', () => {
    pickUpRemote(TV);
    iAm(BOB, 'Bob');
    setTvHostPredicate(() => true);
    expect(mayPickUpRemote(TV)).toBe(true);
    expect(putDownRemote(TV)).toEqual({ ok: true });
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    expect(readRemote(TV).holder).toBe(BOB);
  });

  it('a hacked remote record is read as held by nobody in particular, never trusted for names', () => {
    doc.getMap('tv').set(remoteKey(TV), { holder: 42, name: { x: 1 }, leaseAt: 'soon', by: [] });
    expect(readRemote(TV)).toEqual({ holder: '', name: '', leaseAt: 0, by: '', page: '' });
    expect(remoteStatus(TV)).toBe('free');
  });

  it('is held by a PAGE, not a key: a second tab of the same identity is a viewer, and may take over', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    const lease = readRemote(TV).leaseAt;
    setTvPageId('B'); // the same person, another tab (the seed is shared through localStorage)
    expect(iHoldRemote(TV)).toBe(false);
    expect(remoteStatus(TV)).toBe('held');
    tick(1000);
    renewRemote(TV);
    expect(readRemote(TV).leaseAt).toBe(lease); // not this tab's to renew
    expect(tvHeartbeat(TV, 5_000)).toEqual({ ok: false, error: 'You are holding the remote in another tab.' });
    expect(mayPickUpRemote(TV)).toBe(true); // one person, one place: the newer tab takes it
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    expect(readRemote(TV).page).toBe('B');
    setTvPageId('A');
    expect(iHoldRemote(TV)).toBe(false);
  });

  it('a handed remote belongs to the first of the receiver\'s pages to claim it', () => {
    pickUpRemote(TV);
    handRemote(TV, BOB, 'Bob');
    expect(readRemote(TV).page).toBe('');
    iAm(BOB, 'Bob');
    setTvPageId('B1');
    expect(iHoldRemote(TV)).toBe(false);
    expect(claimRemote(TV)).toBe(true);
    expect(iHoldRemote(TV)).toBe(true);
    expect(readRemote(TV)).toMatchObject({ holder: BOB, page: 'B1', by: ALICE }); // the giver stays on it: the phone pops open
    setTvPageId('B2');
    expect(claimRemote(TV)).toBe(false); // claimed already
    expect(iHoldRemote(TV)).toBe(false);
  });
});

describe('the programme', () => {
  beforeEach(() => { pickUpRemote(TV); });

  it('is off until someone plays something, and the first play starts from the top', () => {
    expect(readTv(TV).state).toBe('off');
    expect(tvPlay(TV, FILM)).toEqual({ ok: true });
    const rec = readTv(TV);
    expect(rec.state).toBe('playing');
    expect(rec.source).toEqual(FILM);
    expect(rec.positionMs).toBe(0);
    expect(rec.seq).toBe(1);
    expect(rec.history[0]).toEqual({ source: FILM, title: 'Metropolis', playedAt: now });
  });

  it('keeps a deduped history, newest first, capped', () => {
    tvPlay(TV, FILM);
    tvPlay(TV, CLIP);
    tvPlay(TV, FILM);
    expect(readTv(TV).history.map((h) => h.title)).toEqual(['Metropolis', 'example.org · clip.mp4']);
    for (let i = 0; i < TV_HISTORY_MAX + 5; i++) {
      tvPlay(TV, { kind: 'url', url: `https://example.org/${i}.mp4` });
    }
    expect(readTv(TV).history).toHaveLength(TV_HISTORY_MAX);
  });

  it('refuses a source the TV cannot play, at the write boundary', () => {
    expect(tvPlay(TV, { kind: 'url', url: 'javascript:alert(1)' })).toEqual({
      ok: false, error: 'That is not something the TV can play.',
    });
    expect(readTv(TV).state).toBe('off');
  });

  it('pauses, resumes and seeks under the remote', () => {
    tvPlay(TV, FILM);
    expect(tvPause(TV, 4_200)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 4200, seq: 2 });
    expect(tvSeek(TV, 9_000)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 9000, seq: 3 });
    expect(tvResume(TV)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 9000, seq: 4 });
    expect(tvResume(TV)).toEqual({ ok: false, error: 'Nothing is paused.' });
  });

  it('stops back to the home screen with the programme kept in history', () => {
    tvPlay(TV, FILM);
    expect(tvStop(TV)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null });
    expect(readTv(TV).history[0]!.source).toEqual(FILM);
  });

  it('every programme ACTION moves the transport revision, a heartbeat never does, and a start marks `started`', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    expect(readTv(TV)).toMatchObject({ seq: 1, started: 1, jump: 1 });
    tvHeartbeat(TV, 3_000);
    expect(readTv(TV)).toMatchObject({ seq: 2, started: 1, jump: 1 });
    tvSeek(TV, 9_000);
    expect(readTv(TV).jump).toBe(2);
    tvPause(TV, 9_500);
    tvResume(TV);
    expect(readTv(TV).jump).toBe(4);
    tvPlay(TV, FILM); // the same film again is a new START
    expect(readTv(TV)).toMatchObject({ seq: 6, started: 6, jump: 5 });
    tvStop(TV);
    expect(readTv(TV).jump).toBe(6);
    // POWER is its own key: it moves the lookup revision, never the programme.
    const revision = tvRevision(TV);
    tvTogglePower(TV);
    expect(readTv(TV).jump).toBe(6);
    expect(tvRevision(TV)).not.toBe(revision);
  });

  it('schedules a start only in the future, and the countdown reads from the record alone', () => {
    expect(tvSchedule(TV, FILM, now - 1)).toEqual({ ok: false, error: 'Pick a time that is still ahead.' });
    expect(tvSchedule(TV, FILM, now + 300_000)).toEqual({ ok: true });
    expect(readPlayback(TV)).toEqual({ state: 'scheduled', positionMs: 0, running: false, countdownMs: 300_000 });
    tick(299_000);
    expect(readPlayback(TV).countdownMs).toBe(1_000);
    expect(tvScreenView(TV).detail).toBe('STARTS IN 0:01');
  });

  it('past T0 the HOLDER reads playing and flips the record with its first heartbeat; a viewer starts on that write', () => {
    pickUpRemote(TV);
    tvSchedule(TV, FILM, now + 10_000);
    tick(12_500);
    expect(readPlayback(TV)).toEqual({ state: 'playing', positionMs: 2_500, running: true, countdownMs: 0 }); // Alice holds
    expect(readTv(TV).state).toBe('scheduled'); // the record itself has not flipped yet
    renewRemote(TV); // the holder's lease, as every page keeps seeing it
    iAm(BOB, 'Bob');
    // Bob's clock may say anything about T0: he waits for the holder's write.
    expect(readPlayback(TV)).toEqual({ state: 'scheduled', positionMs: 0, running: false, countdownMs: 0 });
    expect(tvScreenView(TV).detail).toBe('STARTING…');
    expect(countdownText(0)).toBe('STARTING…');
    expect(countdownText(61_000)).toBe('STARTS IN 1:01');
    iAm(ALICE, 'Alice');
    expect(tvHeartbeat(TV, 2_600)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'playing', startAt: 0, positionMs: 2600 });
    iAm(BOB, 'Bob');
    expect(readPlayback(TV).state).toBe('playing'); // on receipt, anchored to it
  });

  it('past T0 with nobody holding the remote, a viewer free-runs from the UTC start, best effort', () => {
    pickUpRemote(TV);
    tvSchedule(TV, FILM, now + 10_000);
    putDownRemote(TV);
    iAm(BOB, 'Bob');
    tick(12_500);
    expect(readPlayback(TV)).toEqual({ state: 'playing', positionMs: 2_500, running: true, countdownMs: 0 });
  });

  it('the body buttons need no remote: power keeps the programme, volume is the set\'s', () => {
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 60_000);
    iAm(BOB, 'Bob'); // not the holder
    const revision = tvRevision(TV);
    expect(tvTogglePower(TV)).toBe(false);
    expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: 60_000 });
    expect(tvRevision(TV)).not.toBe(revision); // a lookup in flight is void
    expect(tvHeartbeat(TV, 61_000)).toEqual({ ok: false, error: 'Alice has the remote.' });
    expect(tvTogglePower(TV)).toBe(true);
    // The switch is its own key: the programme comes back as it was, and the
    // holder's tick parks it (tvSession); nothing of the programme's was written.
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 60_000 });
    tvSetVolume(TV, 180);
    expect(readTv(TV).volume).toBe(100);
    tvSetVolume(TV, -3);
    expect(readTv(TV).volume).toBe(0);
  });

  it('bounds a peer\'s history before the shape check, not only after it', () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      source: { kind: 'url', url: `https://example.org/${i}.mp4` }, title: `film ${i}`, playedAt: i,
    }));
    doc.getMap('tv').set(tvKey(TV), { ...readTv(TV), state: 'home', history: entries });
    const history = readTv(TV).history;
    expect(history).toHaveLength(TV_HISTORY_MAX);
    expect(history[0]!.title).toBe('film 0');
  });

  it('a peer\'s garbage record degrades to "off", never to a wedged TV', () => {
    doc.getMap('tv').set(tvKey(TV), {
      source: { kind: 'bogus', url: 'file:///etc/passwd' }, state: 'playing', positionMs: -9, seq: 'x',
      history: [{ source: { kind: 'url', url: 'javascript:1' } }, 7], volume: 'loud',
    });
    expect(readTv(TV).state).toBe('off'); // the switch was never turned on
    doc.getMap('tv').set(powerKey(TV), { on: true, seq: 1 });
    const rec = readTv(TV);
    expect(rec.source).toBeNull();
    expect(rec.state).toBe('home'); // "playing" nothing is the home screen
    expect(rec.positionMs).toBe(0);
    expect(rec.seq).toBe(0);
    expect(rec.history).toEqual([]);
    expect(rec.volume).toBe(70);
  });

  it('notifies by key, so a TV panel does not repaint for another TV', () => {
    const calls: string[] = [];
    subscribeTvKey(tvKey(TV), () => calls.push('tv'));
    subscribeTvKey(remoteKey(TV), () => calls.push('remote'));
    subscribeTvKey(volumeKey(TV), () => calls.push('volume'));
    tvPlay(TV, FILM);
    renewRemote(TV);
    tvSetVolume(TV, 30);
    pickUpRemote('smart-tv-2');
    expect(calls).toEqual(['tv', 'remote', 'volume']);
  });

  it('a peer\'s garbage volume reads as the default, and an out-of-range one is clamped', () => {
    doc.getMap('tv').set(volumeKey(TV), 'loud');
    expect(readTv(TV).volume).toBe(70);
    doc.getMap('tv').set(volumeKey(TV), { volume: 250 });
    expect(readTv(TV).volume).toBe(100);
  });

  it('a peer\'s garbage power record reads as off', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    doc.getMap('tv').set(powerKey(TV), { on: 'yes', seq: -2 });
    expect(readTv(TV).state).toBe('off');
    expect(tvHeartbeat(TV, 1_000)).toEqual({ ok: false, error: 'The set is off.' });
  });

  it('a peer\'s revision counter that cannot move reads as the floor, so every write after it still moves', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    // Finite, a number, and useless: + 1 changes none of these.
    for (const stuck of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, 2 ** 60, 1.5, -1, 'x', null]) {
      doc.getMap('tv').set(tvKey(TV), { ...readProgramme(TV), seq: stuck, started: stuck, jump: stuck });
      expect(readProgramme(TV)).toMatchObject({ seq: 0, started: 0, jump: 0 });
      doc.getMap('tv').set(powerKey(TV), { on: true, seq: stuck });
      expect(readPower(TV).seq).toBe(0);
    }
    // The ceiling reads as itself, and the bump past it is the floor again —
    // moved, which is all a revision must do: a heartbeat over it is a NEW
    // sample to anchor to.
    doc.getMap('tv').set(tvKey(TV), { ...readProgramme(TV), seq: TV_COUNTER_MAX, jump: TV_COUNTER_MAX });
    expect(readProgramme(TV)).toMatchObject({ seq: TV_COUNTER_MAX, jump: TV_COUNTER_MAX });
    expect(tvHeartbeat(TV, 1_000).ok).toBe(true);
    expect(readProgramme(TV).seq).toBe(0);
    expect(readSample(TV)).toMatchObject({ seq: 0, positionMs: 1_000 });
    // A seek over a stuck seq and jump is a new seq and a new jump…
    doc.getMap('tv').set(tvKey(TV), { ...readProgramme(TV), seq: Number.MAX_VALUE, jump: Number.MAX_VALUE });
    expect(tvSeek(TV, 5_000).ok).toBe(true);
    expect(readProgramme(TV)).toMatchObject({ seq: 1, jump: 1 });
    // …and a press over a stuck power seq a new revision: the lookup in
    // flight is voided, and the set does go off.
    doc.getMap('tv').set(powerKey(TV), { on: true, seq: Number.MAX_VALUE });
    const revision = tvRevision(TV);
    expect(tvTogglePower(TV)).toBe(false);
    expect(tvRevision(TV)).not.toBe(revision);
    expect(readPower(TV)).toEqual({ on: false, seq: 1 });
  });

  it('a power press on one device never undoes the holder\'s heartbeat on another, nor the other way round', () => {
    // Alice (the holder) beats on her doc while Bob switches the set off on
    // his, offline; synced both ways, the set is off AND Alice's position
    // stands — the switch has a key of its own, so the two never met.
    const alice = doc;
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    bindTvDoc(bob);
    iAm(BOB, 'Bob');
    expect(tvTogglePower(TV)).toBe(false);
    bindTvDoc(alice);
    iAm(ALICE, 'Alice');
    expect(tvHeartbeat(TV, 45_000)).toEqual({ ok: true }); // from her pre-update doc
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    for (const d of [alice, bob]) {
      bindTvDoc(d);
      expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: 45_000, source: FILM });
    }
    bindTvDoc(bob);
    iAm(BOB, 'Bob');
    expect(tvTogglePower(TV)).toBe(true);
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 45_000 }); // back as it was
  });

  it('a volume press on one device never carries a stale programme over a seek on another', () => {
    // Two pages with a doc each, syncing afterwards: Alice (the holder)
    // seeks while Bob turns the sound down. The volume has a key of its own,
    // so the two writes never meet in one LWW slot — both land, on both.
    const alice = doc;
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    bindTvDoc(bob);
    iAm(BOB, 'Bob');
    tvSetVolume(TV, 20); // on Bob's page, not yet synced
    bindTvDoc(alice);
    iAm(ALICE, 'Alice');
    expect(tvSeek(TV, 60_000)).toEqual({ ok: true }); // on Alice's, the same moment
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    for (const d of [alice, bob]) {
      bindTvDoc(d);
      expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 60_000, volume: 20 });
    }
  });
});

describe('the sync rule: anchor on receipt, never on the holder\'s clock', () => {
  it('a new seq lands with THIS page\'s clock, and the room\'s position runs from it', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 30_000);
    expect(readSample(TV)).toEqual({ seq: 2, positionMs: 30_000, receivedAt: now });
    tick(1_400);
    expect(readPlayback(TV).positionMs).toBe(31_400);
    // Half the measured round trip is added when the caller knows it.
    expect(readPlayback(TV, now, 200).positionMs).toBe(31_500);
    // The same seq again is NOT a new sample (a paused record re-written).
    tick(600);
    expect(readSample(TV)!.receivedAt).toBe(now - 2_000);
  });

  it('a late joiner anchors the record it finds to its own now', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 50_000);
    const late = new Y.Doc();
    Y.applyUpdate(late, Y.encodeStateAsUpdate(doc));
    now += 5_000;
    bindTvDoc(late);
    expect(readSample(TV)).toEqual({ seq: 2, positionMs: 50_000, receivedAt: now });
  });

  it('expectedPositionMs and driftAction', () => {
    expect(expectedPositionMs({ positionMs: 1000, receivedAt: 10 }, 510)).toBe(1500);
    expect(expectedPositionMs({ positionMs: 1000, receivedAt: 10 }, 510, 200)).toBe(1600);
    // NetworkProvider reports NaN until its first pong: no lead, never NaN
    // (a NaN expectation read as "speed up" forever and swallowed every seek).
    expect(expectedPositionMs({ positionMs: 1000, receivedAt: 10 }, 510, NaN)).toBe(1500);
    expect(expectedPositionMs({ positionMs: 1000, receivedAt: 10 }, 510, 60_000)).toBe(1500 + TV_RTT_LEAD_CAP_MS);
    expect(driftAction(10_000, NaN, true)).toBe('none');
    expect(driftAction(NaN, 10_000, false)).toBe('none');
    expect(driftAction(10_000, 10_100, true)).toBe('none');
    expect(driftAction(10_000, 10_400, true)).toBe('speed-up');
    expect(driftAction(10_900, 10_400, true)).toBe('slow-down');
    expect(driftAction(10_000, 10_400, false)).toBe('none'); // YouTube: no fine rate steps
    expect(driftAction(10_000, 10_000 + TV_SEEK_OVER_MS + 1, false)).toBe('seek');
    expect(driftAction(10_000 + TV_SEEK_OVER_MS + 1, 10_000, true)).toBe('seek');
  });

  it('formats clocks', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(TV_HEARTBEAT_MS).toBe(3_000);
  });
});

describe('sources', () => {
  it('parses the links the paste box accepts', () => {
    expect(parseTvSource('https://www.youtube.com/watch?v=uPwPecwX2zs&t=5')).toEqual({ kind: 'youtube', videoId: 'uPwPecwX2zs' });
    expect(parseTvSource('youtu.be/uPwPecwX2zs')).toEqual({ kind: 'youtube', videoId: 'uPwPecwX2zs' });
    expect(parseTvSource('https://youtube.com/shorts/uPwPecwX2zs')).toEqual({ kind: 'youtube', videoId: 'uPwPecwX2zs' });
    expect(parseTvSource('uPwPecwX2zs')).toEqual({ kind: 'youtube', videoId: 'uPwPecwX2zs' });
    expect(parseTvSource('https://archive.org/details/his_girl_friday')).toEqual({ kind: 'archive', identifier: 'his_girl_friday', file: '' });
    expect(parseTvSource('https://archive.org/download/his_girl_friday/his_girl_friday.mp4')).toEqual({
      kind: 'archive', identifier: 'his_girl_friday', file: 'his_girl_friday.mp4',
    });
    expect(parseTvSource('https://example.org/a%20film.mp4')).toEqual({ kind: 'url', url: 'https://example.org/a%20film.mp4' });
    expect(parseTvSource('')).toBeNull();
    expect(parseTvSource('not a link at all')).toBeNull();
    expect(parseTvSource('javascript:alert(1)')).toBeNull();
    expect(parseTvSource('ftp://example.org/film.mp4')).toBeNull(); // a scheme of its own is kept, then refused
    expect(parseTvSource('https://www.youtube.com/watch?v=short')).toBeNull();
  });

  it('never carries credentials into the room, keeps spaces in archive filenames, survives bad encoding', () => {
    // user:password@host would be read by every peer, not just the media host.
    expect(parseTvSource('https://user:secret@example.org/film.mp4')).toBeNull();
    expect(sanitizeSource({ kind: 'url', url: 'https://user:secret@example.org/film.mp4' })).toBeNull();
    expect(sanitizeSource({ kind: 'url', url: 'https://user@example.org/film.mp4' })).toBeNull();
    // archive filenames carry spaces as a rule; sourceFileUrl encodes them.
    expect(parseTvSource('https://archive.org/download/his_girl_friday/a%20film.mp4')).toEqual({
      kind: 'archive', identifier: 'his_girl_friday', file: 'a film.mp4',
    });
    expect(sourceFileUrl({ kind: 'archive', identifier: 'his_girl_friday', file: 'a film.mp4' }))
      .toBe('https://archive.org/download/his_girl_friday/a%20film.mp4');
    expect(sanitizeSource({ kind: 'archive', identifier: 'x', file: 'a\u0000b.mp4' })).toBeNull();
    expect(sanitizeSource({ kind: 'archive', identifier: 'x', file: ' leading.mp4' })).toBeNull();
    expect(sanitizeSource({ kind: 'archive', identifier: 'x', file: '/etc/passwd' })).toBeNull();
    // "%ZZ" passes new URL() but not decodeURIComponent: an invalid link, said the normal way.
    expect(parseTvSource('https://archive.org/download/movie/clip%ZZ.mp4')).toBeNull();
    expect(isStartOnly({ kind: 'archive', identifier: 'x', file: '' })).toBe(true);
    expect(isStartOnly({ kind: 'archive', identifier: 'x', file: 'a.mp4' })).toBe(false);
    expect(isStartOnly({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe(false);
  });

  it('labels and file URLs', () => {
    expect(sourceLabel(FILM)).toBe('Metropolis');
    expect(sourceLabel({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe('YouTube · uPwPecwX2zs');
    expect(sourceLabel({ kind: 'archive', identifier: 'x', file: 'y.mp4' })).toBe('archive.org · x');
    expect(sourceFileUrl(FILM)).toBeNull();
    expect(sourceFileUrl({ kind: 'archive', identifier: 'his girl', file: '' })).toBeNull();
    expect(sourceFileUrl({ kind: 'archive', identifier: 'his_girl_friday', file: 'a b.mp4' })).toBe(
      'https://archive.org/download/his_girl_friday/a%20b.mp4',
    );
    expect(sourceFileUrl(CLIP)).toBe(CLIP.url);
  });

  it('sanitises what a peer wrote', () => {
    expect(sanitizeSource({ kind: 'youtube', videoId: '<script>' })).toBeNull();
    expect(sanitizeSource({ kind: 'archive', identifier: '../etc', file: 'x' })).toBeNull();
    expect(sanitizeSource({ kind: 'url', url: 'ftp://x/y.mp4' })).toBeNull();
    expect(sanitizeSource({ kind: 'url', url: CLIP.url, title: 'x'.repeat(200) })!.title).toHaveLength(80);
  });
});

describe('the in-world screen', () => {
  it('derives its view from the records alone', () => {
    expect(tvScreenView(TV)).toMatchObject({ state: 'off', title: '' });
    tvTogglePower(TV);
    expect(tvScreenView(TV)).toMatchObject({ state: 'home', title: 'FURLONG TV', detail: 'REMOTE ON THE SET' });
    pickUpRemote(TV);
    expect(tvScreenView(TV).detail).toBe('REMOTE · Alice');
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 61_000);
    expect(tvScreenView(TV)).toMatchObject({ state: 'playing', title: 'METROPOLIS', lane: 'CONVENIENCE', clockText: '1:01' });
    tvPause(TV, 61_000);
    expect(tvScreenView(TV).detail).toBe('PAUSED · REMOTE · Alice');
  });
});
