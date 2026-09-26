/**
 * 🎂 partyDoc — the birthday gate and the two-phase cake.
 *
 * The gate is the whole feature: a party room where anyone can blow out the
 * candles is a room with balloons in it, not a party. These cases drive the
 * real module against a real Y.Doc, and the hostile-write cases go through the
 * MAP DIRECTLY — that is the path a peer running edited code actually takes,
 * so the read boundary has to survive it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindPartyDoc,
  blowCandles,
  closeGift,
  DEFAULT_CANDLES,
  isBirthdayPerson,
  openGift,
  writeGiftWish,
  setPartyHostPredicate,
  readBirthdayPub,
  readCake,
  readGift,
  readSpeaker,
  relightCandles,
  setBirthdayPub,
  subscribeParty,
  subscribePartyKey,
  toggleSpeaker,
  cakeKey,
} from './partyDoc';

const HONOUREE = 'AAAAhonoureepub';
const GUEST = 'BBBBguestpub';
const CAKE = 'cake-1';

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindPartyDoc(doc);
});

describe('the birthday role', () => {
  it('starts empty, and nobody is the honouree', () => {
    expect(readBirthdayPub()).toBe('');
    expect(isBirthdayPerson(GUEST)).toBe(false);
    // The empty role must not match an empty pubkey — otherwise a client that
    // failed to mint an identity would silently BE the guest of honour.
    expect(isBirthdayPerson('')).toBe(false);
  });

  it('round-trips through the doc and can be cleared', () => {
    setBirthdayPub(HONOUREE);
    expect(readBirthdayPub()).toBe(HONOUREE);
    expect(isBirthdayPerson(HONOUREE)).toBe(true);
    expect(isBirthdayPerson(GUEST)).toBe(false);
    setBirthdayPub('');
    expect(isBirthdayPerson(HONOUREE)).toBe(false);
  });
});

describe('the cake — two phases', () => {
  it('is lit with the default candle count before anyone touches it', () => {
    expect(readCake(CAKE)).toEqual({ lit: true, candles: DEFAULT_CANDLES });
  });

  it('refuses a guest, naming whose candles they are', () => {
    setBirthdayPub(HONOUREE);
    const result = blowCandles(CAKE, GUEST, 'Mia');
    expect(result).toEqual({ ok: false, error: 'Waiting for Mia to blow out the candles!' });
    // …and the refusal changed nothing.
    expect(readCake(CAKE).lit).toBe(true);
  });

  it('still answers a guest when the honouree has no known name', () => {
    setBirthdayPub(HONOUREE);
    const result = blowCandles(CAKE, GUEST, '   ');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('the guest of honour');
  });

  it('refuses everyone while no honouree is named', () => {
    expect(blowCandles(CAKE, GUEST, '').ok).toBe(false);
    // Including the room owner — an unnamed role is not "anyone", it is nobody.
    expect(blowCandles(CAKE, HONOUREE, '').ok).toBe(false);
    expect(readCake(CAKE).lit).toBe(true);
  });

  it('lets the honouree blow them out, once', () => {
    setBirthdayPub(HONOUREE);
    expect(blowCandles(CAKE, HONOUREE, 'Mia')).toEqual({ ok: true });
    expect(readCake(CAKE).lit).toBe(false);
    // The candle COUNT survives the blow — it is the cake's size, not its phase.
    expect(readCake(CAKE).candles).toBe(DEFAULT_CANDLES);
    expect(blowCandles(CAKE, HONOUREE, 'Mia')).toEqual({
      ok: false,
      error: 'The candles are already out.',
    });
  });

  it('keeps each cake instance separate', () => {
    setBirthdayPub(HONOUREE);
    blowCandles(CAKE, HONOUREE, 'Mia');
    expect(readCake('cake-2').lit).toBe(true);
  });

  it('re-lights for the next party, clamping a silly candle count', () => {
    setBirthdayPub(HONOUREE);
    blowCandles(CAKE, HONOUREE, 'Mia');
    relightCandles(CAKE, 7);
    expect(readCake(CAKE)).toEqual({ lit: true, candles: 7 });
    relightCandles(CAKE, 9999);
    expect(readCake(CAKE).candles).toBeLessThanOrEqual(12);
    relightCandles(CAKE, -3);
    expect(readCake(CAKE).candles).toBe(0);
  });
});

describe('reads survive a hostile peer writing the map directly', () => {
  it('falls back to a sane cake for junk of any shape', () => {
    const map = doc.getMap('party');
    for (const junk of [null, 42, 'lit', [], { candles: 'five' }, { candles: NaN }]) {
      map.set(cakeKey(CAKE), junk);
      const cake = readCake(CAKE);
      expect(typeof cake.lit).toBe('boolean');
      expect(Number.isInteger(cake.candles)).toBe(true);
      expect(cake.candles).toBeGreaterThanOrEqual(0);
      expect(cake.candles).toBeLessThanOrEqual(12);
    }
  });

  it('never lets a non-string role become somebody', () => {
    doc.getMap('party').set('birthday', { pub: GUEST });
    expect(readBirthdayPub()).toBe('');
    expect(isBirthdayPerson(GUEST)).toBe(false);
  });

  it('truncates an oversized opener name instead of rendering it', () => {
    doc.getMap('party').set('gift:g1', { opened: true, byName: 'x'.repeat(500) });
    expect(readGift('g1').byName).toHaveLength(32);
  });
});

describe('gifts and the speaker — the ungated half', () => {
  it('opens once, recording who did it', () => {
    expect(readGift('g1')).toEqual({ opened: false, byName: '', wish: '', wishBy: '', wishByName: '' });
    expect(openGift('g1', 'Alluxia')).toEqual({ ok: true });
    expect(readGift('g1')).toMatchObject({ opened: true, byName: 'Alluxia' });
    expect(openGift('g1', 'Someone else')).toEqual({ ok: false, error: 'Already opened.' });
    // The first opener is not overwritten by the second attempt.
    expect(readGift('g1').byName).toBe('Alluxia');
  });

  it('names an anonymous opener rather than leaving the line blank', () => {
    openGift('g2', '');
    expect(readGift('g2').byName).toBe('A clone');
  });

  it('re-wraps', () => {
    openGift('g3', 'Alluxia');
    closeGift('g3');
    expect(readGift('g3')).toMatchObject({ opened: false, byName: '' });
  });

  it('starts the music on and toggles it', () => {
    expect(readSpeaker('s1').on).toBe(true);
    expect(toggleSpeaker('s1')).toBe(false);
    expect(readSpeaker('s1').on).toBe(false);
    expect(toggleSpeaker('s1')).toBe(true);
  });
});

describe('subscriptions', () => {
  it('fires the general listener on any write, and unsubscribes cleanly', () => {
    let hits = 0;
    const off = subscribeParty(() => { hits += 1; });
    const baseline = hits;
    setBirthdayPub(HONOUREE);
    expect(hits).toBeGreaterThan(baseline);
    const afterWrite = hits;
    off();
    toggleSpeaker('s1');
    expect(hits).toBe(afterWrite);
  });

  it('fires a keyed listener only for its own key', () => {
    let cakeHits = 0;
    subscribePartyKey(cakeKey(CAKE), () => { cakeHits += 1; });
    const baseline = cakeHits;
    toggleSpeaker('s1');
    expect(cakeHits).toBe(baseline); // a speaker write is not a cake write
    setBirthdayPub(HONOUREE);
    blowCandles(CAKE, HONOUREE, 'Mia');
    expect(cakeHits).toBeGreaterThan(baseline);
  });

  it('a listener that throws does not starve the ones behind it', () => {
    let reached = false;
    // Listeners are module-level, so both must come off again or they keep
    // firing (and keep logging) through every later test in the file.
    const offBad = subscribeParty(() => { throw new Error('boom'); });
    const offGood = subscribeParty(() => { reached = true; });
    expect(() => toggleSpeaker('s1')).not.toThrow();
    expect(reached).toBe(true);
    offBad();
    offGood();
  });
});

describe('rebinding (the T0 seam)', () => {
  it('reads the NEW room after a rebind, not the old one', () => {
    setBirthdayPub(HONOUREE);
    blowCandles(CAKE, HONOUREE, 'Mia');
    expect(readCake(CAKE).lit).toBe(false);

    bindPartyDoc(new Y.Doc()); // walked into a different room
    expect(readBirthdayPub()).toBe('');
    expect(readCake(CAKE).lit).toBe(true);
  });
});

describe('💌 the wish on the tag', () => {
  it('takes anyone\'s wish on a blank tag, and survives opening and re-wrapping', () => {
    expect(writeGiftWish('w1', '  Happy birthday,   Dorkmo!  ', 'pub-a', 'Ana')).toEqual({ ok: true });
    expect(readGift('w1')).toMatchObject({ wish: 'Happy birthday, Dorkmo!', wishBy: 'pub-a', wishByName: 'Ana', opened: false });
    openGift('w1', 'Bo');
    expect(readGift('w1')).toMatchObject({ opened: true, byName: 'Bo', wish: 'Happy birthday, Dorkmo!' });
    closeGift('w1');
    expect(readGift('w1')).toMatchObject({ opened: false, byName: '', wish: 'Happy birthday, Dorkmo!', wishByName: 'Ana' });
  });

  it('lets only the writer or the owner change a written tag', () => {
    setPartyHostPredicate(() => false); // a guest's client
    writeGiftWish('w2', 'From Ana', 'pub-a', 'Ana');
    expect(writeGiftWish('w2', 'From Bo', 'pub-b', 'Bo')).toEqual({ ok: false, error: 'Ana already wrote on this one.' });
    expect(readGift('w2').wish).toBe('From Ana');
    expect(writeGiftWish('w2', 'From Ana, with love', 'pub-a', 'Ana')).toEqual({ ok: true });
    // Host authority is the registered room-owner check, not a caller's word.
    setPartyHostPredicate(() => true);
    expect(writeGiftWish('w2', 'Tidied by the host', 'pub-host', 'Host')).toEqual({ ok: true });
    expect(readGift('w2')).toMatchObject({ wish: 'Tidied by the host', wishByName: 'Host' });
    // The host can also take it off; a blank on a blank tag is refused.
    expect(writeGiftWish('w2', '', 'pub-host', 'Host')).toEqual({ ok: true });
    expect(readGift('w2').wish).toBe('');
    setPartyHostPredicate(() => false);
    expect(writeGiftWish('w2', '   ', 'pub-a', 'Ana').ok).toBe(false);
  });

  it('caps the wish at 120 characters and shape-checks a hostile record', () => {
    writeGiftWish('w3', 'x'.repeat(500), 'pub-a', 'Ana');
    expect(readGift('w3').wish).toHaveLength(120);
    doc.getMap('party').set('gift:w4', { opened: 'yes', wish: 42, wishBy: null });
    expect(readGift('w4')).toEqual({ opened: false, byName: '', wish: '', wishBy: '', wishByName: '' });
  });
});
