/**
 * 📺 tvDoc — the TV's records against a real Y.Doc: the room's clock
 * (whoever pressed last: any press takes it, it lapses, it is let go), the
 * clock page's own writes, the shape-checked reads that survive a
 * peer's garbage, and the sync maths that never compares two clocks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindTvDoc, countdownText, driftAction, expectedPositionMs, formatClock, holderAnchorMs, iHoldRemote, isStartOnly,
  markTvPageAwake, parseTvSource, pickUpRemote, putDownRemote, readPlayback, readPower, readProgramme,
  readRemote, readSample, readTv, remoteKey, remoteStatus, renewRemote, sanitizeSource, setTvClock,
  setTvIdentity, setTvPageId, sourceFileUrl, sourceLabel, sourceLane, subscribeTvKey, tvHeartbeat,
  tvKey, tvNoteEnd, tvPause, tvPlay, tvProgrammeEnded, tvResume, tvSchedule, tvScreenView, tvSeek, tvSetLoop, tvSetVolume, tvStop,
  tvTogglePower, TV_COUNTER_MAX, TV_HEARTBEAT_MS, TV_HISTORY_MAX, TV_LEASE_LAPSE_MS, TV_RTT_LEAD_CAP_MS,
  TV_SEEK_OVER_MS, powerKey, tvRevision, volumeKey, libraryKey, readLibrary, TV_HOME_RECENT, TV_LIBRARY_MAX,
  sourceId,
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
  setTvPageId('A');
  bindTvDoc(doc);
  iAm(ALICE, 'Alice');
});

describe('the room\'s clock: whoever pressed last', () => {
  it('starts with nobody, and any press takes it for the presser\'s page', () => {
    expect(remoteStatus(TV)).toBe('free');
    expect(tvPlay(TV, FILM)).toEqual({ ok: true });
    expect(iHoldRemote(TV)).toBe(true);
    expect(readRemote(TV)).toEqual({ holder: ALICE, name: 'Alice', leaseAt: now, by: ALICE, page: 'A' });
  });

  it('a second player\'s press goes through while the first keeps the clock, and the clock is theirs from then on', () => {
    tvPlay(TV, FILM);
    iAm(BOB, 'Bob');
    setTvPageId('B');
    expect(remoteStatus(TV)).toBe('held');
    expect(tvPause(TV, 5_000)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 5_000 });
    expect(readRemote(TV)).toMatchObject({ holder: BOB, name: 'Bob', page: 'B' });
    expect(iHoldRemote(TV)).toBe(true);
    // Alice's page keeps it no longer: nothing to renew, and her player's beat is refused.
    iAm(ALICE, 'Alice');
    setTvPageId('A');
    expect(iHoldRemote(TV)).toBe(false);
    const lease = readRemote(TV).leaseAt;
    tick(1000);
    renewRemote(TV);
    expect(readRemote(TV).leaseAt).toBe(lease);
    expect(tvHeartbeat(TV, 6_000)).toEqual({ ok: false, error: 'This page does not keep this TV\'s clock.' });
    // Her next press takes it back.
    expect(tvResume(TV)).toEqual({ ok: true });
    expect(readRemote(TV).holder).toBe(ALICE);
  });

  it('every press on the programme goes through from anyone, each taking the clock', () => {
    tvPlay(TV, CLIP);
    const presses: Array<() => { ok: boolean }> = [
      () => tvPause(TV, 1_000),
      () => tvResume(TV),
      () => tvSeek(TV, 2_000),
      () => tvSetLoop(TV, true),
      () => tvSchedule(TV, FILM, now + 60_000),
      () => tvPlay(TV, FILM),
      () => tvStop(TV),
    ];
    presses.forEach((go, n) => {
      const who = `CCCC${n}pub`;
      iAm(who);
      setTvPageId(`P${n}`);
      expect(go()).toEqual({ ok: true });
      expect(readRemote(TV)).toMatchObject({ holder: who, page: `P${n}` });
    });
    expect(readTv(TV).state).toBe('home');
  });

  it('a press that changes nothing leaves the clock where it is', () => {
    tvPlay(TV, CLIP);
    iAm(BOB, 'Bob');
    setTvPageId('B');
    expect(tvResume(TV)).toEqual({ ok: false, error: 'Nothing is paused.' });
    expect(tvSetLoop(TV, false)).toEqual({ ok: true }); // off already
    expect(tvPlay(TV, { kind: 'url', url: 'ftp://x/y.mp4' }).ok).toBe(false);
    expect(tvSchedule(TV, FILM, now - 1).ok).toBe(false);
    expect(readRemote(TV).holder).toBe(ALICE);
  });

  it('what only the clock\'s page writes stays its own: the beat, the end, the close at the end', () => {
    expect(tvHeartbeat(TV, 1_000)).toEqual({ ok: false, error: 'This page does not keep this TV\'s clock.' });
    expect(tvNoteEnd(TV, 30_000).ok).toBe(false);
    expect(tvProgrammeEnded(TV).ok).toBe(false);
    tvPlay(TV, CLIP);
    expect(tvHeartbeat(TV, 1_000)).toEqual({ ok: true });
    expect(tvNoteEnd(TV, 30_000)).toEqual({ ok: true });
    iAm(BOB, 'Bob');
    setTvPageId('B');
    expect(tvHeartbeat(TV, 2_000).ok).toBe(false);
    expect(tvNoteEnd(TV, 40_000).ok).toBe(false);
    expect(tvProgrammeEnded(TV).ok).toBe(false);
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 1_000, endMs: 30_000 });
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

  it('is let go only by the page that keeps it: a press elsewhere since then is left with it', () => {
    tvPlay(TV, FILM);
    setTvPageId('B'); // Alice's other tab
    expect(putDownRemote(TV)).toEqual({ ok: true });
    expect(readRemote(TV).page).toBe('A'); // nothing written
    iAm(BOB, 'Bob');
    expect(putDownRemote(TV)).toEqual({ ok: true });
    expect(readRemote(TV).holder).toBe(ALICE);
    iAm(ALICE, 'Alice');
    setTvPageId('A');
    expect(putDownRemote(TV)).toEqual({ ok: true });
    expect(remoteStatus(TV)).toBe('free');
  });

  it('a holder that slept past the lapse has let go by its own watch: not its own on waking, not renewed, and its next press takes it afresh', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    const lease = readRemote(TV).leaseAt;
    now += TV_LEASE_LAPSE_MS - 1;
    expect(remoteStatus(TV)).toBe('mine');
    now += 1; // the tab slept through its renewals
    expect(remoteStatus(TV)).toBe('free');
    expect(iHoldRemote(TV)).toBe(false);
    renewRemote(TV); // waking up renewing would race whoever pressed meanwhile
    expect(readRemote(TV).leaseAt).toBe(lease);
    expect(tvHeartbeat(TV, 5_000).ok).toBe(false);
    expect(tvSeek(TV, 5_000)).toEqual({ ok: true }); // a press, like anyone's
    expect(readRemote(TV).leaseAt).toBe(now);
    expect(remoteStatus(TV)).toBe('mine');
  });

  it('a hacked remote record is read as held by nobody in particular, never trusted for names', () => {
    doc.getMap('tv').set(remoteKey(TV), { holder: 42, name: { x: 1 }, leaseAt: 'soon', by: [] });
    expect(readRemote(TV)).toEqual({ holder: '', name: '', leaseAt: 0, by: '', page: '' });
    expect(remoteStatus(TV)).toBe('free');
  });

  it('is kept by a PAGE, not a key: a second tab of the same identity is a viewer until it presses', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    const lease = readRemote(TV).leaseAt;
    setTvPageId('B'); // the same person, another tab (the seed is shared through localStorage)
    expect(iHoldRemote(TV)).toBe(false);
    expect(remoteStatus(TV)).toBe('held');
    tick(1000);
    renewRemote(TV);
    expect(readRemote(TV).leaseAt).toBe(lease); // not this tab's to renew
    expect(tvHeartbeat(TV, 5_000)).toEqual({ ok: false, error: 'Your other tab keeps this TV\'s clock.' });
    expect(tvSeek(TV, 5_000)).toEqual({ ok: true });
    expect(readRemote(TV).page).toBe('B');
    setTvPageId('A');
    expect(iHoldRemote(TV)).toBe(false);
  });
});

describe('the end the record carries', () => {
  it('is the holder\'s to file, neither a sample nor a transport action, zeroed by a new programme, and read as a number whatever a peer wrote', () => {
    pickUpRemote(TV);
    expect(tvNoteEnd(TV, 30_000)).toEqual({ ok: false, error: 'Nothing is playing.' });
    tvPlay(TV, CLIP);
    const { seq, jump } = readTv(TV);
    expect(tvNoteEnd(TV, 30_000)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ endMs: 30_000, seq, jump });
    expect(tvNoteEnd(TV, null)).toEqual({ ok: true }); // the unbounded marker: 0 on the wire
    expect(readTv(TV).endMs).toBe(0);
    tvNoteEnd(TV, 30_000);
    tvPause(TV, 5_000);
    expect(readTv(TV).endMs).toBe(30_000); // a pause keeps it
    tvPlay(TV, CLIP); // a new programme: its own player says where it ends
    expect(readTv(TV).endMs).toBe(0);
    tvNoteEnd(TV, 30_000);
    tvStop(TV);
    expect(readTv(TV).endMs).toBe(0);
    tvPlay(TV, CLIP);
    iAm(BOB);
    setTvPageId('B');
    expect(tvNoteEnd(TV, 5_000).ok).toBe(false); // not the holder
    doc.getMap('tv').set(tvKey(TV), { ...(doc.getMap('tv').get(tvKey(TV)) as object), endMs: 'soon' });
    expect(readProgramme(TV).endMs).toBe(0);
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
    expect(readTv(TV)).toMatchObject({ seq: 6, started: 2, jump: 5 }); // `started` counts starts, not writes
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
    tick(7_000);
    renewRemote(TV); // the holder's tick keeps the lease live through the countdown
    tick(5_500);
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

  it('the holder may pause a schedule past T0 before its first beat flips the record — it is playing by the clock — and never a countdown still ahead', () => {
    pickUpRemote(TV);
    tvSchedule(TV, FILM, now + 10_000);
    expect(tvPause(TV, 0)).toEqual({ ok: false, error: 'Nothing is playing.' });
    tick(7_000);
    renewRemote(TV);
    tick(5_500);
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 2_500 });
    expect(tvPause(TV, 2_500)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'paused', startAt: 0, positionMs: 2_500 }); // the schedule spent
    expect(readPlayback(TV)).toEqual({ state: 'paused', positionMs: 2_500, running: false, countdownMs: 0 });
    expect(tvResume(TV)).toEqual({ ok: true });
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 2_500 });
  });

  it('turning the set on is a press like any: the presser\'s page keeps the clock, a live keeper\'s included', () => {
    putDownRemote(TV);
    expect(remoteStatus(TV)).toBe('free');
    expect(tvTogglePower(TV)).toBe(true);
    expect(readRemote(TV)).toMatchObject({ holder: ALICE, page: 'A' }); // on the set → the presser's
    expect(tvTogglePower(TV)).toBe(false); // off: the remote stays in hand
    expect(readRemote(TV).holder).toBe(ALICE);
    iAm(BOB, 'Bob');
    expect(tvTogglePower(TV)).toBe(true); // Alice's hold is live, and the switch takes it: whoever turns the set on holds the remote
    expect(readRemote(TV)).toMatchObject({ holder: BOB, by: BOB, page: 'A' });
    iAm(ALICE, 'Alice');
    expect(remoteStatus(TV)).toBe('held'); // Alice sees the switch took it…
    expect(tvTogglePower(TV)).toBe(false); // …and OFF moves nothing
    expect(readRemote(TV).holder).toBe(BOB);
    expect(tvTogglePower(TV)).toBe(true); // …but her own ON takes it back, like anyone's
    expect(readRemote(TV).holder).toBe(ALICE);
    tvTogglePower(TV);
    iAm(BOB, 'Bob');
    tick(TV_LEASE_LAPSE_MS); // Alice went quiet
    expect(tvTogglePower(TV)).toBe(true);
    expect(readRemote(TV)).toMatchObject({ holder: BOB, page: 'A' }); // lapsed → the presser's, as any
  });

  it('the body buttons need no remote: power keeps the programme, volume is the set\'s', () => {
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 60_000);
    iAm(BOB, 'Bob'); // not the clock's
    const revision = tvRevision(TV);
    expect(tvTogglePower(TV)).toBe(false);
    expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: 60_000 });
    expect(tvRevision(TV)).not.toBe(revision); // a lookup in flight is void
    expect(tvHeartbeat(TV, 61_000)).toEqual({ ok: false, error: 'This page does not keep this TV\'s clock.' }); // OFF took nothing
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
    expect(readPower(TV)).toMatchObject({ on: false, seq: 1 });
  });

  it('a press on one device never loses to the clock page\'s beat on another taken before it saw the press', () => {
    // Alice's page keeps the clock and beats on her doc while Bob, on his,
    // pauses: both written before either has seen the other. The beat has a
    // key of its own, so whichever device the merge favours, Bob's PAUSE
    // stands, and the beat taken under the action before it is not laid
    // over it.
    for (const [aliceId, bobId] of [[1, 2], [2, 1]] as const) {
      const alice = new Y.Doc();
      alice.clientID = aliceId;
      bindTvDoc(alice);
      iAm(ALICE, 'Alice');
      setTvPageId('A');
      expect(tvPlay(TV, FILM)).toEqual({ ok: true });
      const bob = new Y.Doc();
      bob.clientID = bobId;
      Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
      bindTvDoc(bob);
      iAm(BOB, 'Bob');
      setTvPageId('B');
      tick(1_000);
      expect(tvPause(TV, 31_000)).toEqual({ ok: true });
      bindTvDoc(alice);
      iAm(ALICE, 'Alice');
      setTvPageId('A');
      expect(tvHeartbeat(TV, 31_200)).toEqual({ ok: true }); // she has not seen the pause yet
      Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
      Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
      for (const d of [alice, bob]) {
        bindTvDoc(d);
        expect(readTv(TV)).toMatchObject({ state: 'paused', positionMs: 31_000 });
        expect(readRemote(TV).holder).toBe(BOB);
      }
    }
  });

  it('a beat is read over the programme it was taken under, while newer than the record\'s own sample', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tick(TV_HEARTBEAT_MS);
    expect(tvHeartbeat(TV, 3_000)).toEqual({ ok: true });
    const beaten = readProgramme(TV);
    expect(beaten).toMatchObject({ state: 'playing', positionMs: 3_000, at: now });
    expect(doc.getMap('tv').get(tvKey(TV))).toMatchObject({ positionMs: 0 }); // the record itself is untouched
    // A page from before the beat key beats into the record itself: newer
    // than the beat, it stands.
    doc.getMap('tv').set(tvKey(TV), { ...beaten, positionMs: 6_000, seq: beaten.seq + 1 });
    expect(readProgramme(TV)).toMatchObject({ positionMs: 6_000, seq: beaten.seq + 1 });
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

  it('OFF carries where the room was by the presser\'s reading, ON anchors every page there, and the holder\'s next heartbeat takes over', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 10_000);
    tick(20_000);
    expect(readPlayback(TV).positionMs).toBe(30_000);
    // Anyone may press the body button: Bob, a viewer, by his own reading.
    iAm(BOB, 'Bob');
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV)).toMatchObject({ on: false, parkMs: 30_000 });
    expect(readTv(TV)).toMatchObject({ state: 'off', positionMs: 10_000 }); // the programme untouched
    tick(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true);
    expect(readPower(TV)).toMatchObject({ on: true, parkMs: 30_000 }); // carried on
    // Resumed where it was switched off, not a minute further on.
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 30_000 });
    tick(1_000);
    expect(readPlayback(TV).positionMs).toBe(31_000);
    // A change to any other key does not anchor the room at the reading again.
    tvSetVolume(TV, 40);
    expect(readPlayback(TV).positionMs).toBe(31_000);
    // The holder's next heartbeat replaces the anchor as any sample is
    // replaced (Bob holds: the ON put the lapsed remote in his hand).
    expect(tvHeartbeat(TV, 31_500)).toEqual({ ok: true });
    expect(readPlayback(TV).positionMs).toBe(31_500);
    tick(500);
    expect(readPlayback(TV).positionMs).toBe(32_000);
  });

  it('a park at the start is a reading: switched off at 0, ON anchors at 0 and the minute off is not playback', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 0); // rewound to the top: the holder's beat at 0
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV)).toMatchObject({ on: false, parkMs: 0 });
    tick(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true);
    expect(readPower(TV)).toMatchObject({ on: true, parkMs: 0 }); // carried on, a reading
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 0 }); // anchored at 0, not a minute in
    tick(1_000);
    expect(readPlayback(TV).positionMs).toBe(1_000);
  });

  it('OFF during a schedule past T0 carries the time since T0 — a schedule plays by the clock whoever holds — ON anchors there, and the time off is not playback', () => {
    pickUpRemote(TV);
    tvSchedule(TV, FILM, now + 10_000);
    putDownRemote(TV); // nobody holds: past T0 everyone free-runs from the UTC start
    iAm(BOB, 'Bob');
    tick(12_500);
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 2_500 });
    expect(readTv(TV).state).toBe('scheduled'); // the record never flipped: no holder to beat
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV)).toMatchObject({ on: false, parkMs: 2_500 });
    expect(readTv(TV).state).toBe('off');
    tick(60_000); // off for a minute
    expect(tvTogglePower(TV)).toBe(true); // the free remote is the presser's
    expect(readPower(TV)).toMatchObject({ on: true, parkMs: 2_500 });
    expect(readTv(TV).state).toBe('scheduled'); // the switch never touches the programme's slot
    expect(readSample(TV)).toMatchObject({ positionMs: 2_500, receivedAt: now, park: true });
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 2_500 }); // where it was switched off, not 62.5 s in
    tick(1_000);
    expect(readPlayback(TV).positionMs).toBe(3_500);
    // The holder's first beat flips the record and replaces the anchor as
    // any sample is replaced.
    expect(tvHeartbeat(TV, 3_600)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'playing', startAt: 0, positionMs: 3_600 });
    expect(readPlayback(TV).positionMs).toBe(3_600);
  });

  it('OFF from a page whose reading is stale carries no reading — a beat the network delivered after the wake reads ahead of the room by the sleep — unless the stale sample is its own last beat, the holder\'s clock bridged across its sleep', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    markTvPageAwake(now); // the room tick, as World runs it
    tvHeartbeat(TV, 10_000); // this page's own beat
    tick(500);
    markTvPageAwake(now);
    tick(60_000); // the lid closed for a minute; the monotonic clock ran on
    markTvPageAwake(now); // the first tick back finds the gap
    expect(readPlayback(TV)).toMatchObject({ positionMs: 70_500, stale: true });
    // The holder's own beat, bridged across its own sleep, is where every
    // awake viewer ran on to: a reading.
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV).parkMs).toBe(70_500);
    expect(tvTogglePower(TV)).toBe(true); // lapsed by this page's own watch: picked up again with the switch
    expect(tvHeartbeat(TV, 70_600)).toEqual({ ok: true });
    // Another page's beat — the remote lapsed from this one and was taken
    // over — held by the network through this page's next sleep and
    // delivered in the moment after waking: stamped from before the gap
    // and bridged by the whole sleep, it reads a minute AHEAD of the room.
    // Not a reading for the room: the switch carries none.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    tick(500);
    markTvPageAwake(now);
    tick(60_000);
    markTvPageAwake(now);
    const rec = readProgramme(TV);
    other.getMap('tv').set(tvKey(TV), { ...rec, positionMs: 71_000, seq: rec.seq + 1 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(readPlayback(TV).stale).toBe(true);
    expect(readPlayback(TV).positionMs).toBeGreaterThan(71_000 + 59_000);
    iAm(BOB, 'Bob'); // anyone may press the body button
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV)).toMatchObject({ on: false, parkMs: null });
    // ON with no reading anchors nothing: the record as it stands, and the
    // holder's park at its last beat (tvSession).
    expect(tvTogglePower(TV)).toBe(true);
    expect(readSample(TV)?.park).toBeUndefined();
    expect(readTv(TV)).toMatchObject({ state: 'playing', positionMs: 71_000 });
  });

  it('a viewer\'s OFF during STARTING… (the holder\'s first beat still owed) carries the time since T0, as that beat will say; a countdown still ahead carries nothing, and ON during it starts nothing early', () => {
    pickUpRemote(TV);
    tvSchedule(TV, FILM, now + 10_000);
    tick(7_000);
    renewRemote(TV); // the holder's tick keeps the lease live through the countdown
    tick(5_000);
    iAm(BOB, 'Bob');
    expect(readPlayback(TV)).toMatchObject({ state: 'scheduled', countdownMs: 0 }); // STARTING…: Bob waits for Alice's write
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV).parkMs).toBe(2_000);
    iAm(ALICE, 'Alice');
    expect(tvTogglePower(TV)).toBe(true); // Alice turns it on: the remote is hers, as it was
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 2_000 }); // the holder reads the anchor, not the time since T0
    // A countdown still ahead: nothing running, no reading to carry, and
    // the start stays at T0.
    expect(tvSchedule(TV, CLIP, now + 30_000)).toEqual({ ok: true });
    expect(tvTogglePower(TV)).toBe(false);
    expect(readPower(TV).parkMs).toBeNull();
    tick(5_000);
    expect(tvTogglePower(TV)).toBe(true);
    expect(readPlayback(TV)).toEqual({ state: 'scheduled', positionMs: 0, running: false, countdownMs: 25_000 });
    tick(25_000);
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 0 }); // T0: from the top
  });

  it('a switch with no reading, or a peer\'s garbage one, anchors nothing; a late joiner anchors to the record, never to an earlier ON', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 10_000);
    doc.getMap('tv').set(powerKey(TV), { on: true, seq: 7, parkMs: 'soon' });
    expect(readPower(TV)).toEqual({ on: true, seq: 7, parkMs: null });
    expect(readPlayback(TV).positionMs).toBe(10_000);
    doc.getMap('tv').set(powerKey(TV), { on: true, seq: 8, parkMs: -5 });
    expect(readPower(TV).parkMs).toBeNull();
    expect(readPlayback(TV).positionMs).toBe(10_000);
    // An OFF and ON a while ago, heartbeats since: a page joining now reads
    // the record as it stands, not the reading the ON carried.
    tvTogglePower(TV); // off, the room at 10 s
    tvTogglePower(TV); // on: 10 s carried
    tvHeartbeat(TV, 50_000);
    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, Y.encodeStateAsUpdate(doc));
    bindTvDoc(joiner);
    expect(readPower(TV).parkMs).toBe(10_000);
    expect(readPlayback(TV).positionMs).toBe(50_000);
    bindTvDoc(doc);
  });

  it('a sample from before this page slept is stale — shown, never acted on — until a fresh one lands after the wake window', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    markTvPageAwake(now); // the room tick, as World runs it
    tvHeartbeat(TV, 10_000);
    tick(500);
    markTvPageAwake(now);
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 10_500 });
    expect(readPlayback(TV).stale).toBeUndefined();
    tick(3_600_000); // the lid closed for an hour; the monotonic clock ran on
    markTvPageAwake(now); // the first tick back finds the gap
    const woke = readPlayback(TV);
    expect(woke.positionMs).toBe(10_000 + 3_600_500); // the sleep, extrapolated…
    expect(woke.stale).toBe(true); // …and known for what it is
    // A heartbeat the network held through the sleep — another page's: the
    // remote lapsed from this one and was taken over — lands in the moment
    // after waking: stamped from before the gap, stale with the rest.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const beatFrom = (positionMs: number) => {
      const rec = readProgramme(TV);
      other.getMap('tv').set(tvKey(TV), { ...rec, positionMs, seq: rec.seq + 1 });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    };
    tick(200);
    markTvPageAwake(now);
    beatFrom(12_000);
    expect(readPlayback(TV).stale).toBe(true);
    // Past the wake window, the holder's next heartbeat is a fresh anchor.
    tick(1_000);
    markTvPageAwake(now);
    beatFrom(13_000);
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 13_000 });
    expect(readPlayback(TV).stale).toBeUndefined();
    tick(500);
    expect(readPlayback(TV).positionMs).toBe(13_500);
    // This page's own write is received as it is written, whatever the
    // marks say: a holder waking and beating is never stale to itself.
    tick(3_600_000);
    markTvPageAwake(now);
    expect(readPlayback(TV).stale).toBe(true);
    tick(100);
    markTvPageAwake(now);
    pickUpRemote(TV); // lapsed by this page's own watch: taken up again, like anyone
    expect(tvHeartbeat(TV, 20_000)).toEqual({ ok: true });
    expect(readPlayback(TV)).toMatchObject({ positionMs: 20_000 });
    expect(readPlayback(TV).stale).toBeUndefined();
  });

  it('a stale reading is bridged on the wall clock: the sleep counts as elapsed whether or not the monotonic clock ran through it', () => {
    let wall = 1_700_000_000_000;
    setTvClock(() => now, () => wall);
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    markTvPageAwake(now);
    tvHeartbeat(TV, 10_000);
    tick(500);
    wall += 500;
    markTvPageAwake(now);
    // The lid closed for an hour and the monotonic clock STOOD STILL (macOS,
    // Linux): the tick back finds a 2.6 s gap by that clock and an hour by
    // the wall clock, and the reading is the hour — where the room is.
    tick(2_600);
    wall += 3_600_000;
    markTvPageAwake(now);
    const woke = readPlayback(TV);
    expect(woke.stale).toBe(true);
    expect(woke.positionMs).toBe(10_000 + 500 + 3_600_000);
    // The hold lapsed by this page's own watch — an hour, as the wall clock
    // measures the gap, whatever the monotonic clock saw of it (remoteLapsed)
    // — and is taken up again, like anyone's. The holder's own beat from
    // there is fresh, and runs on from it.
    expect(iHoldRemote(TV)).toBe(false);
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    expect(tvHeartbeat(TV, woke.positionMs)).toEqual({ ok: true });
    expect(readPlayback(TV).stale).toBeUndefined();
    tick(500);
    wall += 500;
    markTvPageAwake(now);
    expect(readPlayback(TV).positionMs).toBe(10_000 + 500 + 3_600_000 + 500);
    // Where the monotonic clock ran on through the sleep (Windows), the
    // wall clock says the same hour: nothing to add, the same reading.
    tick(3_600_000);
    wall += 3_600_000;
    markTvPageAwake(now);
    expect(readPlayback(TV)).toMatchObject({ stale: true, positionMs: 10_000 + 500 + 3_600_000 + 500 + 3_600_000 });
  });

  it('a gap the wall clock alone finds (the monotonic clock stood still through a sleep, or stepped while awake: one tick\'s worth where an hour passed) is AMBIGUOUS — stale and lapsed as a sleep, never bridged as one — and a lease delivered on waking is stamped from before it', () => {
    let wall = 1_700_000_000_000;
    setTvClock(() => now, () => wall);
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    markTvPageAwake(now);
    tvHeartbeat(TV, 10_000);
    tick(500);
    wall += 500;
    markTvPageAwake(now);
    // The lid closed for an hour — or the wall clock stepped an hour while
    // the page ran: the monotonic clock shows the usual 500 ms between ticks
    // either way, and nothing in the page tells the two apart. Stale, so
    // nothing acts on it; run on by the monotonic clock alone, since an hour
    // is never added to playback on the wall clock's word.
    tick(500);
    wall += 3_600_000;
    markTvPageAwake(now);
    const woke = readPlayback(TV);
    expect(woke.stale).toBe(true);
    expect(woke.positionMs).toBe(10_000 + 1_000);
    // A press elsewhere held by the network through that sleep, its lease
    // delivered on waking BEFORE the first tick back: stamped with the last
    // mark before the gap, which the wall clock finds where the monotonic
    // clock sees none — lapsed by this page's own watch.
    tick(500);
    wall += 500;
    markTvPageAwake(now);
    iAm(BOB, 'Bob');
    setTvPageId('B1');
    const presser = new Y.Doc();
    presser.getMap('tv').set(remoteKey(TV), { holder: 'CCCCcarolpub', name: 'Carol', leaseAt: now, by: 'CCCCcarolpub', page: 'C1' });
    const update = Y.encodeStateAsUpdate(presser);
    tick(500);
    wall += TV_LEASE_LAPSE_MS + 60_000; // the second sleep: no tick yet
    Y.applyUpdate(doc, update);
    expect(remoteStatus(TV)).toBe('free');
    // The first tick back marks the gap; a hold taken up after it is seen
    // afresh, and the lease that lapsed stays lapsed by the bridged measure.
    markTvPageAwake(now);
    expect(remoteStatus(TV)).toBe('free');
    tick(500);
    wall += 500;
    markTvPageAwake(now);
    iAm(ALICE, 'Alice');
    setTvPageId('A');
    expect(pickUpRemote(TV)).toEqual({ ok: true }); // lapsed by this page's own watch: taken up again, like anyone
    expect(tvHeartbeat(TV, 20_000)).toEqual({ ok: true });
    expect(readPlayback(TV).stale).toBeUndefined();
    // A forward wall-clock step shorter than the lapse: stale for one wake
    // window, not bridged, and the hold kept — the room is never seeked
    // forward by a step, and a holder keeps beating from its player.
    tick(500);
    wall += 500 + 5_000; // the step
    markTvPageAwake(now);
    expect(readPlayback(TV)).toMatchObject({ stale: true, positionMs: 20_000 + 500 });
    expect(iHoldRemote(TV)).toBe(true);
    // A backward step is no gap at all.
    tick(500);
    wall -= 60_000;
    markTvPageAwake(now);
    expect(tvHeartbeat(TV, 21_000)).toEqual({ ok: true });
    tick(500);
    wall -= 60_000;
    markTvPageAwake(now);
    expect(readPlayback(TV)).toMatchObject({ positionMs: 21_500 });
    expect(readPlayback(TV).stale).toBeUndefined();
    expect(iHoldRemote(TV)).toBe(true);
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
    expect(readSample(TV)).toEqual({ seq: 2, positionMs: 30_000, receivedAt: now, own: true }); // this page's own beat
    tick(1_400);
    expect(readPlayback(TV).positionMs).toBe(31_400);
    // Half the measured round trip is added when the caller knows it.
    expect(readPlayback(TV, now, 200).positionMs).toBe(31_500);
    // The same seq again is NOT a new sample (a paused record re-written).
    tick(600);
    expect(readSample(TV)!.receivedAt).toBe(now - 2_000);
  });

  it('a wall-clock step is not elapsed playback: receipt and drift run on the monotonic clock', () => {
    let mono = 10_000;
    let wall = 1_700_000_000_000;
    setTvClock(() => mono, () => wall);
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 30_000);
    expect(readSample(TV)).toEqual({ seq: 2, positionMs: 30_000, receivedAt: mono, own: true });
    expect(readTv(TV).history[0].playedAt).toBe(wall); // the stamps that travel are dates
    mono += 1_400;
    expect(readPlayback(TV).positionMs).toBe(31_400);
    // An NTP correction, a wake from sleep: the wall clock jumps a minute.
    // Nothing seeks — the room's position moved by what the monotonic clock
    // measured, not by what the date says.
    wall += 60_000;
    expect(readPlayback(TV).positionMs).toBe(31_400);
    wall -= 120_000;
    expect(readPlayback(TV).positionMs).toBe(31_400);
    // Nor does a wall step lapse a live lease: that is elapsed time too.
    expect(remoteStatus(TV)).toBe('mine');
    mono += TV_LEASE_LAPSE_MS;
    expect(remoteStatus(TV)).toBe('free');
  });

  it('the schedule is a date: the countdown reads the wall clock, whatever the monotonic clock does', () => {
    let mono = 10_000;
    let wall = 1_700_000_000_000;
    setTvClock(() => mono, () => wall);
    pickUpRemote(TV);
    expect(tvSchedule(TV, FILM, wall + 60_000)).toEqual({ ok: true });
    mono += 3_600_000; // an hour of monotonic time moves no countdown
    expect(readPlayback(TV).countdownMs).toBe(60_000);
    wall += 59_000;
    expect(readPlayback(TV).countdownMs).toBe(1_000);
    wall += 3_500;
    renewRemote(TV);
    // Past T0 the holder free-runs from the UTC start: a wall-clock distance.
    expect(readPlayback(TV)).toEqual({ state: 'playing', positionMs: 2_500, running: true, countdownMs: 0 });
  });

  it("a late joiner runs the record it finds on by its writer's clock, from its own now", () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 50_000);
    expect(readProgramme(TV).at).toBe(now); // the writer's wall clock, with the position
    const late = new Y.Doc();
    Y.applyUpdate(late, Y.encodeStateAsUpdate(doc));
    now += 5_000;
    setTvPageId('B');
    iAm(BOB, 'Bob');
    bindTvDoc(late);
    // Written 5 s ago by the writer's clock: the room is 5 s on.
    expect(readSample(TV)).toEqual({ seq: 2, positionMs: 55_000, receivedAt: now, wall: true });
    expect(readPlayback(TV).positionMs).toBe(55_000);
    // The holder's next beat is fresh on arrival: anchored as any sample.
    setTvPageId('A');
    iAm(ALICE, 'Alice');
    now += 1_000;
    tvHeartbeat(TV, 56_000);
    expect(readSample(TV)).toMatchObject({ positionMs: 56_000, receivedAt: now });
    expect(readSample(TV)).not.toHaveProperty('wall');
  });

  it("never runs a record back, nor on from a clock it cannot read", () => {
    let wall = now;
    setTvClock(() => now, () => wall);
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    // The writer's clock a minute AHEAD of the joiner's: no time has passed
    // by the joiner's reading, and it starts where the record says.
    wall += 60_000;
    tvHeartbeat(TV, 50_000);
    wall -= 60_000;
    const late = new Y.Doc();
    Y.applyUpdate(late, Y.encodeStateAsUpdate(doc));
    bindTvDoc(late);
    expect(readSample(TV)).toMatchObject({ positionMs: 50_000 });
    // A record from before the field (no `at`): anchored to now, as ever.
    const old = new Y.Doc();
    old.getMap('tv').set(tvKey(TV), { ...readProgramme(TV), at: undefined });
    wall += 3_600_000;
    bindTvDoc(old);
    expect(readSample(TV)).toEqual({ seq: readProgramme(TV).seq, positionMs: 50_000, receivedAt: now });
  });

  it('a looping film plays on in an empty room, and whoever walks in joins the lap it is on', () => {
    pickUpRemote(TV);
    tvSetLoop(TV, true);
    tvPlay(TV, CLIP);
    tvNoteEnd(TV, 60_000);
    tvHeartbeat(TV, 50_000);
    putDownRemote(TV); // the holder leaves: nobody runs the laps
    const later = Y.encodeStateAsUpdate(doc);
    now += 100_000;
    setTvPageId('B');
    iAm(BOB, 'Bob');
    const late = new Y.Doc();
    Y.applyUpdate(late, later);
    bindTvDoc(late);
    // 150 s of a 60 s clip: 30 s into its third lap.
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 30_000 });
    // And on, lap after lap, with no one writing a thing.
    now += 40_000;
    expect(readPlayback(TV).positionMs).toBe(10_000);
    expect(tvScreenView(TV).clockText).toBe('0:10');
    // Without LOOP, past the end is the end: nothing wraps it.
    setTvPageId('A');
    iAm(ALICE, 'Alice');
    bindTvDoc(doc);
    pickUpRemote(TV);
    tvSetLoop(TV, false);
    tvHeartbeat(TV, 50_000);
    putDownRemote(TV);
    now += 100_000;
    expect(readPlayback(TV).positionMs).toBe(150_000);
  });

  it('a viewer follows a live holder\'s laps, and runs its own once the remote goes quiet', () => {
    pickUpRemote(TV);
    tvSetLoop(TV, true);
    tvPlay(TV, CLIP);
    tvNoteEnd(TV, 60_000);
    tvHeartbeat(TV, 59_000);
    iAm(BOB, 'Bob'); // a viewer on this page, the holder's lease live
    now += 3_000;
    // The holder's player is the room's clock: its lap comes as a write.
    expect(readPlayback(TV).positionMs).toBe(62_000);
    now += TV_LEASE_LAPSE_MS;
    // Gone quiet: the viewer works the lap out for itself.
    expect(remoteStatus(TV)).toBe('free');
    expect(readPlayback(TV).positionMs).toBe(59_000 + 3_000 + TV_LEASE_LAPSE_MS - 60_000);
  });

  it('whoever picks the remote up in an empty room takes the lap it is on, and runs the laps from their first beat', () => {
    pickUpRemote(TV);
    tvSetLoop(TV, true);
    tvPlay(TV, CLIP);
    tvNoteEnd(TV, 60_000);
    tvHeartbeat(TV, 50_000);
    putDownRemote(TV); // the holder leaves
    now += 100_000;
    setTvPageId('B');
    iAm(BOB, 'Bob');
    // Picked up without a look at the set first: 150 s of a 60 s clip is
    // 30 s into its third lap, for the new holder as for anyone watching —
    // never 150 s, which a holder's player would take for the end.
    expect(pickUpRemote(TV)).toEqual({ ok: true });
    expect(iHoldRemote(TV)).toBe(true);
    expect(readPlayback(TV)).toMatchObject({ state: 'playing', positionMs: 30_000, lap: 2 });
    expect(holderAnchorMs(readPlayback(TV))).toBe(30_000);
    // The holder's first beat, from there, is the room's clock: past the
    // end now is its player ending, and its own lap (tvProgrammeEnded).
    tvHeartbeat(TV, 30_000);
    expect(readPlayback(TV)).toEqual({ state: 'playing', positionMs: 30_000, running: true, countdownMs: 0 });
    now += 3_000;
    renewRemote(TV);
    tvHeartbeat(TV, 59_000);
    now += 3_000;
    expect(readPlayback(TV)).toEqual({ state: 'playing', positionMs: 62_000, running: true, countdownMs: 0 });
  });

  it('a viewer watching the empty room stays on its lap when someone else picks the remote up, until their first beat', () => {
    pickUpRemote(TV);
    tvSetLoop(TV, true);
    tvPlay(TV, CLIP);
    tvNoteEnd(TV, 60_000);
    tvHeartbeat(TV, 50_000);
    putDownRemote(TV);
    now += 100_000;
    setTvPageId('B');
    iAm(BOB, 'Bob');
    expect(readPlayback(TV)).toMatchObject({ positionMs: 30_000, lap: 2 });
    // Carol picks the remote up on her page: her lease lands here, and no
    // beat yet.
    const carols = new Y.Doc();
    Y.applyUpdate(carols, Y.encodeStateAsUpdate(doc));
    carols.getMap('tv').set(remoteKey(TV), { holder: 'CCCCcarolpub', name: 'Carol', leaseAt: now, by: 'CCCCcarolpub', page: 'C' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(carols));
    expect(remoteStatus(TV)).toBe('held');
    now += 1_000;
    expect(readPlayback(TV)).toMatchObject({ positionMs: 31_000, lap: 2 });
    // Her first beat, from where she took the room: her laps from here.
    const rec = readProgramme(TV);
    carols.getMap('tv').set(tvKey(TV), { ...rec, positionMs: 31_000, seq: rec.seq + 1 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(carols));
    now += 5_000;
    expect(readPlayback(TV)).toEqual({ state: 'playing', positionMs: 36_000, running: true, countdownMs: 0 });
  });

  it('a viewer back from a sleep waits for a live holder\'s beat, and follows the room again once nobody holds the remote', () => {
    pickUpRemote(TV);
    tvSetLoop(TV, true);
    tvPlay(TV, CLIP);
    tvNoteEnd(TV, 60_000);
    markTvPageAwake(now);
    tvHeartbeat(TV, 10_000);
    setTvPageId('B'); // a viewer's page; Alice's keeps the remote
    iAm(BOB, 'Bob');
    tick(500);
    markTvPageAwake(now);
    tick(120_000); // Bob's lid closed for two minutes
    markTvPageAwake(now);
    expect(readPlayback(TV).stale).toBe(true);
    // Alice is still there: her renewal lands past the wake window, and the
    // reading stays stale until her next beat.
    const alices = new Y.Doc();
    Y.applyUpdate(alices, Y.encodeStateAsUpdate(doc));
    for (let i = 0; i < 4; i++) { tick(500); markTvPageAwake(now); }
    alices.getMap('tv').set(remoteKey(TV), { ...readRemote(TV), leaseAt: readRemote(TV).leaseAt + 1 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(alices));
    expect(remoteStatus(TV)).toBe('held');
    for (let i = 0; i < 15; i++) { tick(500); markTvPageAwake(now); } // 9.5 s since waking
    expect(readPlayback(TV).stale).toBe(true);
    // Then nothing: her remote goes quiet, and no beat is coming. The room
    // is where its anchor says, laps and all, and Bob's player follows it.
    for (let i = 0; i < 2; i++) { tick(500); markTvPageAwake(now); }
    expect(remoteStatus(TV)).toBe('free');
    const pb = readPlayback(TV);
    expect(pb.stale).toBeUndefined();
    expect(pb).toEqual({ state: 'playing', positionMs: (10_000 + 131_000) % 60_000, running: true, countdownMs: 0, lap: 2 });
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

  it('📦 reads a blob source only with a hash, a provider id and a size it can bound', () => {
    const H = 'b'.repeat(64);
    const P = 'a'.repeat(64);
    expect(sanitizeSource({ kind: 'blob', hash: H, size: 1234, provider: P, mime: 'video/mp4', title: 'Sintel' }))
      .toEqual({ kind: 'blob', hash: H, size: 1234, provider: P, mime: 'video/mp4', title: 'Sintel' });
    // A type that is not plainly video/* or audio/* is left out, the source kept.
    expect(sanitizeSource({ kind: 'blob', hash: H, size: 1, provider: P, mime: 'text/html' })).toEqual({ kind: 'blob', hash: H, size: 1, provider: P });
    expect(sanitizeSource({ kind: 'blob', hash: H.toUpperCase(), size: 1, provider: P })).toBeNull();
    expect(sanitizeSource({ kind: 'blob', hash: H, size: 1, provider: 'not-a-node' })).toBeNull();
    expect(sanitizeSource({ kind: 'blob', hash: H, size: 0, provider: P })).toBeNull();
    expect(sanitizeSource({ kind: 'blob', hash: H, size: 2 ** 41, provider: P })).toBeNull();
    expect(sanitizeSource({ kind: 'blob', hash: H, size: '12', provider: P })).toBeNull();
    expect(sourceLane({ kind: 'blob', hash: H, size: 1, provider: P })).toBe('SOVEREIGN');
    expect(sourceFileUrl({ kind: 'blob', hash: H, size: 1, provider: P })).toBeNull(); // read from the viewer's own node, never a URL in the record
    expect(sourceLabel({ kind: 'blob', hash: H, size: 1, provider: P })).toBe('a file · bbbbbbbb');
    expect(isStartOnly({ kind: 'blob', hash: H, size: 1, provider: P })).toBe(false);
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

describe('🔁 LOOP', () => {
  it('is anyone\'s to set, neither a sample nor a transport action, kept across programmes, and read as a boolean whatever a peer wrote', () => {
    iAm(BOB, 'Bob');
    expect(tvSetLoop(TV, true)).toEqual({ ok: true }); // nothing on: the set's setting all the same
    expect(tvSetLoop(TV, false)).toEqual({ ok: true });
    iAm(ALICE, 'Alice');
    pickUpRemote(TV);
    tvPlay(TV, CLIP);
    const { seq, jump, started } = readTv(TV);
    expect(tvSetLoop(TV, true)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ loop: true, seq, jump, started });
    tvStop(TV);
    tvPlay(TV, FILM);
    expect(readTv(TV).loop).toBe(true); // the set's setting: the next film loops too
    iAm(BOB);
    setTvPageId('B');
    expect(tvSetLoop(TV, false)).toEqual({ ok: true }); // Bob's press, from his own page
    expect(readTv(TV).loop).toBe(false);
    expect(readRemote(TV).holder).toBe(BOB);
    doc.getMap('tv').set(tvKey(TV), { ...(doc.getMap('tv').get(tvKey(TV)) as object), loop: 'yes' });
    expect(readProgramme(TV).loop).toBe(false);
  });

  it('a lap leaves a lookup in flight standing (an upload for PLAY NOW over a looping film); a programme action still voids it', () => {
    pickUpRemote(TV);
    tvPlay(TV, CLIP);
    tvSetLoop(TV, true);
    const revision = tvRevision(TV);
    tvProgrammeEnded(TV);
    tvProgrammeEnded(TV);
    expect(readTv(TV).laps).toBe(2);
    expect(tvRevision(TV)).toBe(revision);
    tvPause(TV, 1_000);
    expect(tvRevision(TV)).not.toBe(revision);
    const paused = tvRevision(TV);
    tvSetLoop(TV, false);
    tvProgrammeEnded(TV); // the end with LOOP off is STOP: home
    expect(readTv(TV).state).toBe('home');
    expect(tvRevision(TV)).not.toBe(paused);
    doc.getMap('tv').set(tvKey(TV), { ...(doc.getMap('tv').get(tvKey(TV)) as object), laps: -3 });
    expect(readProgramme(TV).laps).toBe(0);
  });

  it('a lap that wraps one counter past its ceiling and not the other is still no action', () => {
    pickUpRemote(TV);
    tvPlay(TV, CLIP);
    tvSetLoop(TV, true);
    doc.getMap('tv').set(tvKey(TV), { ...(doc.getMap('tv').get(tvKey(TV)) as object), jump: TV_COUNTER_MAX, laps: 0 });
    const revision = tvRevision(TV);
    tvProgrammeEnded(TV);
    expect(readTv(TV)).toMatchObject({ jump: 0, laps: 1 });
    expect(tvRevision(TV)).toBe(revision);
    tvProgrammeEnded(TV);
    expect(tvRevision(TV)).toBe(revision);
  });

  it('at the end starts the same programme over from the top, the end kept and the history and library left alone; without it, home', () => {
    pickUpRemote(TV);
    tvPlay(TV, CLIP);
    tvNoteEnd(TV, 30_000);
    tvHeartbeat(TV, 30_000);
    tvSetLoop(TV, true);
    const before = readTv(TV);
    const library = readLibrary();
    expect(tvProgrammeEnded(TV)).toEqual({ ok: true });
    const after = readTv(TV);
    expect(after).toMatchObject({ state: 'playing', source: CLIP, positionMs: 0, endMs: 30_000, loop: true });
    // A new start, as PLAY NOW again is: a player that cannot seek is rebuilt, one that can goes back to 0.
    expect(after.started).toBeGreaterThan(before.started);
    expect(after.jump).toBeGreaterThan(before.jump);
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(after.history).toEqual(before.history);
    expect(readLibrary()).toEqual(library);
    // The same showing: a viewer's ✕ is kept against it, so a lap does not undo it.
    expect(after.showing).toBe(before.showing);
    expect(before.showing).toBe(before.started);
    expect(readPlayback(TV).positionMs).toBe(0);
    tvPlay(TV, CLIP); // PLAY NOW again is another showing
    expect(readTv(TV).showing).toBe(readTv(TV).started);
    expect(readTv(TV).showing).toBeGreaterThan(after.showing);
    tvSchedule(TV, CLIP, now + 60_000);
    expect(readTv(TV).showing).toBe(readTv(TV).started);
    // A peer's garbage, or a showing ahead of the start, reads as the start.
    for (const bad of ['1', -1, 1.5, readTv(TV).started + 1]) {
      doc.getMap('tv').set(tvKey(TV), { ...(doc.getMap('tv').get(tvKey(TV)) as object), showing: bad });
      expect(readProgramme(TV).showing).toBe(readProgramme(TV).started);
    }
    tvPlay(TV, CLIP);
    tvSetLoop(TV, false);
    expect(tvProgrammeEnded(TV)).toEqual({ ok: true });
    expect(readTv(TV)).toMatchObject({ state: 'home', source: null });
    iAm(BOB);
    setTvPageId('B');
    expect(tvProgrammeEnded(TV).ok).toBe(false); // only the holder ends a programme
  });
});

describe('the in-world screen', () => {
  it('derives its view from the records alone', () => {
    expect(tvScreenView(TV)).toMatchObject({ state: 'off', title: '' });
    tvTogglePower(TV); // turning the set on is a press: Alice's page keeps the clock
    expect(tvScreenView(TV)).toMatchObject({ state: 'home', title: 'FURLONG TV', detail: 'ANY SPACEPHONE IS THE REMOTE' });
    tvPlay(TV, FILM);
    tvHeartbeat(TV, 61_000);
    expect(tvScreenView(TV)).toMatchObject({
      state: 'playing', title: 'METROPOLIS', lane: 'CONVENIENCE', clockText: '1:01', detail: 'LAST PRESS · Alice',
    });
    tvPause(TV, 61_000);
    expect(tvScreenView(TV).detail).toBe('PAUSED · LAST PRESS · Alice');
    tvSetLoop(TV, true);
    expect(tvScreenView(TV).detail).toBe('PAUSED · LOOP · LAST PRESS · Alice');
    tvResume(TV);
    expect(tvScreenView(TV).detail).toBe('LOOP · LAST PRESS · Alice');
    putDownRemote(TV); // Alice's page leaves: the room runs on by itself
    expect(tvScreenView(TV).detail).toBe('LOOP');
  });
});

describe('`started` is a counter of its own', () => {
  it('moves on every start whatever a peer wrote into seq and started — a start never reads as drift', () => {
    pickUpRemote(TV);
    tvPlay(TV, FILM);
    // A shape-valid peer record with the counters out of step: derived from
    // seq, `started` would come back as 1 — unmoved — on the next start.
    doc.getMap('tv').set(tvKey(TV), { ...readProgramme(TV), seq: 0, started: 1 });
    expect(readTv(TV)).toMatchObject({ seq: 0, started: 1 });
    tvPlay(TV, FILM);
    expect(readTv(TV).started).toBe(2);
    tvSchedule(TV, FILM, now + 60_000, now);
    expect(readTv(TV).started).toBe(3);
    tvHeartbeat(TV, 1_000); // never a heartbeat
    expect(readTv(TV).started).toBe(3);
    // The other way round too: a peer's `started` far ahead of `seq`.
    doc.getMap('tv').set(tvKey(TV), { ...readProgramme(TV), seq: 1, started: 40 });
    tvPlay(TV, FILM);
    expect(readTv(TV).started).toBe(41);
  });
});

describe('📚 the room\'s library', () => {
  const IH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const BLOB: TvSource = { kind: 'blob', hash: 'b'.repeat(64), size: 129_000_000, provider: 'c'.repeat(64), mime: 'video/mp4', title: 'Sintel' };
  beforeEach(() => { pickUpRemote(TV); });

  it('notes every play and schedule under a key of its own, newest first', () => {
    tvPlay(TV, FILM, now);
    tick(1_000);
    tvSchedule(TV, CLIP, now + 60_000, now);
    expect(readLibrary().map((e) => e.title)).toEqual(['example.org · clip.mp4', 'Metropolis']);
    expect(doc.getMap('tv').get(libraryKey(FILM))).toBeTruthy();
    tick(1_000);
    tvPlay(TV, FILM, now);
    const [top] = readLibrary();
    expect(top).toMatchObject({ title: 'Metropolis', plays: 2, addedAt: 1_000_000, playedAt: now });
  });

  it('is the room\'s, shared by every set in it', () => {
    tvPlay(TV, FILM, now);
    pickUpRemote('smart-tv-2');
    tick(5);
    tvPlay('smart-tv-2', CLIP, now);
    expect(readLibrary()).toHaveLength(2);
  });

  it('remembers how a torrent\'s file is got again, and keeps it through a replay', () => {
    tvPlay(TV, BLOB, now, { ih: IH, file: 3 });
    expect(readLibrary()[0]!.torrent).toEqual({ ih: IH, file: 3 });
    // The programme itself names only the blob.
    expect(JSON.stringify(readTv(TV))).not.toContain(IH);
    tick(10);
    tvPlay(TV, { ...BLOB, provider: 'd'.repeat(64) }, now);
    expect(readLibrary()[0]).toMatchObject({ plays: 2, torrent: { ih: IH, file: 3 }, source: { provider: 'd'.repeat(64) } });
    // Only a blob carries one, and only a well-formed one.
    tvPlay(TV, FILM, now, { ih: IH, file: 1 });
    expect(readLibrary().find((e) => e.source.kind === 'youtube')!.torrent).toBeUndefined();
    tvPlay(TV, { ...BLOB, hash: 'e'.repeat(64) }, now, { ih: 'nope', file: 1 } as never);
    expect(readLibrary().find((e) => e.source.kind === 'blob' && e.source.hash === 'e'.repeat(64))!.torrent).toBeUndefined();
  });

  it('takes a time from the far future for none, so it can neither top the list nor outlive a real play', () => {
    const map = doc.getMap('tv');
    for (let i = 0; i < TV_LIBRARY_MAX; i++) {
      const source: TvSource = { kind: 'url', url: `https://example.org/future-${i}.mp4` };
      map.set(libraryKey(source), { source, title: `future ${i}`, addedAt: 1e100, playedAt: 1e100, plays: 1 });
    }
    // A peer clock a few minutes fast is still believed.
    const soon: TvSource = { kind: 'url', url: 'https://example.org/soon.mp4' };
    map.set(libraryKey(soon), { source: soon, title: 'soon', addedAt: now + 60_000, playedAt: now + 60_000, plays: 1 });
    expect(readLibrary()[0]!.title).toBe('soon');
    expect(readLibrary().find((e) => e.title === 'future 0')).toMatchObject({ playedAt: 0, addedAt: 0 });
    tick(1);
    tvPlay(TV, FILM, now);
    const lib = readLibrary();
    expect(lib.map((e) => e.title).slice(0, 2)).toEqual(['soon', 'Metropolis']);
    expect(lib).toHaveLength(TV_LIBRARY_MAX);
    // The pruning took far-future entries, never the play just written.
    expect(map.get(libraryKey(FILM))).toBeTruthy();
  });

  it('keeps the newest TV_LIBRARY_MAX, dropping the oldest on a write', () => {
    for (let i = 0; i < TV_LIBRARY_MAX + 3; i++) {
      tick(1);
      tvPlay(TV, { kind: 'url', url: `https://example.org/${i}.mp4` }, now);
    }
    const lib = readLibrary();
    expect(lib).toHaveLength(TV_LIBRARY_MAX);
    expect(lib[0]!.source).toEqual({ kind: 'url', url: `https://example.org/${TV_LIBRARY_MAX + 2}.mp4` });
    expect([...doc.getMap('tv').keys()].filter((k) => k.startsWith('lib:'))).toHaveLength(TV_LIBRARY_MAX);
  });

  it('reads a peer\'s entries with care', () => {
    const map = doc.getMap('tv');
    map.set('lib:url:https://example.org/a.mp4', { source: { kind: 'url', url: 'javascript:1' }, title: 'x', playedAt: 5 });
    // An entry under another source's key is not that source's.
    map.set('lib:youtube:aaaaaaaaaaa', { source: FILM, title: 'forged', playedAt: 9 });
    map.set(libraryKey(CLIP), { source: CLIP, title: 'y'.repeat(500), playedAt: 'soon', plays: -4, torrent: { ih: IH, file: 1 } });
    map.set(libraryKey(BLOB), { source: BLOB, playedAt: 7, addedAt: 99, torrent: { ih: IH.toUpperCase(), file: 2 } });
    const lib = readLibrary();
    expect(lib.map((e) => e.source.kind)).toEqual(['blob', 'url']);
    expect(lib[0]).toMatchObject({ title: 'Sintel', addedAt: 7, plays: 1, torrent: { ih: IH, file: 2 } });
    expect(lib[1]!.title).toHaveLength(80);
    expect(lib[1]!.torrent).toBeUndefined();
  });

  it('puts its newest titles on the home screen', () => {
    expect(tvScreenView(TV).recent).toBeUndefined();
    for (const [i, t] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      tick(1);
      tvPlay(TV, { kind: 'url', url: `https://example.org/${i}.mp4`, title: t }, now);
    }
    tvStop(TV);
    expect(tvScreenView(TV)).toMatchObject({ state: 'home', recent: ['E', 'D', 'C', 'B'] });
    expect(TV_HOME_RECENT).toBe(4);
  });
});

describe('🗜 a smaller copy, as the room sees it', () => {
  const ORIGINAL = { kind: 'blob' as const, hash: 'b'.repeat(64), size: 2_000_000_000, provider: 'c'.repeat(64), mime: 'video/mp4', title: 'Sintel' };
  const SMALL = { kind: 'blob' as const, hash: 'e'.repeat(64), size: 550_000_000, provider: 'c'.repeat(64), mime: 'video/mp4', title: 'Sintel' };

  it('is the same programme and library entry as its original, and reads with care', () => {
    const copy = sanitizeSource({ ...SMALL, was: { hash: ORIGINAL.hash, size: ORIGINAL.size } });
    expect(copy).toMatchObject({ hash: SMALL.hash, was: { hash: ORIGINAL.hash, size: ORIGINAL.size } });
    expect(sourceId(copy!)).toBe(sourceId(ORIGINAL));
    expect(libraryKey(copy!)).toBe(libraryKey(ORIGINAL));
    // A `was` that is no file, or the copy itself, is left off.
    expect(sanitizeSource({ ...SMALL, was: { hash: 'nope', size: 5 } })).not.toHaveProperty('was');
    expect(sanitizeSource({ ...SMALL, was: { hash: ORIGINAL.hash, size: 0 } })).not.toHaveProperty('was');
    expect(sanitizeSource({ ...SMALL, was: { hash: SMALL.hash, size: 5 } })).not.toHaveProperty('was');
  });

  it('takes the place of its original in the library, keeping the count', () => {
    pickUpRemote(TV);
    tvPlay(TV, ORIGINAL, now);
    tick(1_000);
    tvPlay(TV, { ...SMALL, was: { hash: ORIGINAL.hash, size: ORIGINAL.size } }, now);
    const lib = readLibrary();
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ plays: 2, source: { hash: SMALL.hash, was: { hash: ORIGINAL.hash } } });
  });
});
