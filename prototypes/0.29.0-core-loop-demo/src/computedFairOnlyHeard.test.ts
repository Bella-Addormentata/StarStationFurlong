/**
 * 🔒🏠 The house is heard at a FAIR ONLY game (design §8.4 P3, PR 6c-4b-1b): a
 * page hears the beats of the keys a live game depends on for its next close
 * (the house that carried the commitment the round must name, while it is still
 * one of the game's houses, or the houses that joined it), and no close, and a
 * shorter abandon, waits for the house whose commitment it names, whoever
 * delegated it.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the first page's doc as its owner's page would write it;
 * the houses are TestHouses whose records and heartbeats a spec writes by hand,
 * as the node's house job would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, sealFin } from './computedFairOnly';
import { asAbandon, asClose, dutyRank, nextSid3 } from './computedFold';
import type { CloseRec, FoldResult } from './computedFold';
import { buyer, delegation, hex, house as H, house2 as H2, NAME, owner, rootOf, trimOf, xferOf } from './computedFairOnlyKit';
import { Beating, beatOf, clockOf, deleteIn, keysIn, loadPage, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run as runBare, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testHouse } from './computedTestKit';
import type { Built, TestHouse } from './computedTestKit';
import { commitHouses, committingHouse, HOUSE_HEARD_MS, houseOfCommit, houseSign, roomSignBytes } from './computedHouse';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The roulette game the owner opens at the table, in the page kit's room. */
const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
const rootFor = (patch: Record<string, unknown> = {}) => rootOf(G, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM), ...patch });
const kit = new ComputedKit(G);
/** The session the root opens. */
const SID = nextSid3(G, rootFor().value);
/** Another table of the room, and its game (the owner's again), its house H2. */
const T2 = 'roulette-2';
const G2 = { room: PAGE_ROOM, t: T2, inc: faironlyInc('p', PAGE_ROOM, T2, NAME) };
const kit2 = new ComputedKit(G2);
/** A key that is no house of any game. */
const STRANGER = testHouse('heard-stranger');

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const hashIn = (key: string): string => key.slice(key.lastIndexOf(':') + 1);
const closesOf = (p: Page, r: number, t = TABLE): CloseRec[] => keysIn(p, 'c', r, t).map((k) => asClose(p.casino.computedSessionForWrite(t)!.get(k))!);
const foldOf = (p: Page, t = TABLE) => p.casino.computedFoldOf(t)!;
/** The house's records put in the game's live session on page p. */
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]));
/** Whether page p heard house `pub` in the HOUSE_HEARD_MS before T. */
const heard = (p: Page, pub: string, T: number): boolean => p.casino.houseHeardFrom(pub, T);
/** The keys page p hears as the houses of the game, sorted. */
const housesOf = (p: Page, t = TABLE, inc = G.inc): string[] => [...p.casino.computedGameHouses(t, inc)].sort();

/** The room's doc bound again on page p, holding what it held (the page loads, or the room's doc is replaced). */
function rebind(p: Page): void {
  const doc2 = new Y.Doc();
  doc2.clientID = 77;
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(p.doc));
  p.casino.setComputedVerifyForTests({ now: () => 0 });
  p.casino.bindCasinoDoc(doc2, PAGE_ROOM);
  p.doc = doc2;
}

/** House h's heartbeat n written into page p's doc at the spec's time T, as its node writes one. */
function beatIn(p: Page, T: number, h: TestHouse, n: number): void {
  clockOf(p, T);
  const [key, rec] = beatOf(PAGE_ROOM, h, n);
  p.doc.transact(() => top(p).set(key, rec));
}

/** The owner holds the deed of page p's room and delegates `houses` for it: the room's own houses, pinned. */
function pinHouses(p: Page, ...houses: TestHouse[]): void {
  p.doc.transact(() => p.doc.getMap('players').set(owner.pid, { keyB64: owner.pub, name: owner.pid }));
  p.doc.transact(() => p.doc.getMap('roomInfo').set('owner', owner.pid));
  p.doc.transact(() => {
    for (const h of houses) top(p).set(`hk:${h.pub}`, delegation(owner, h.pub, PAGE_ROOM));
  });
}

/** The houses that beat while a spec runs its game, as their nodes do: a beat in page a's doc every HEARTBEAT_MS
 *  (Beating) each, or none. A spec sets who beats, and mutes one to let it fall silent. */
let beating: Beating[] = [];
const run = (pages: Page[], from: number, to: number, opts: Parameters<typeof runBare>[3] = {}): number =>
  runBare(pages, from, to, { each: (T) => beating.forEach((b) => b.each(T)), ...opts });

/** Pages `names`, 1,000 chips each, and the game open in the first page's doc (its root, and the live session it
 *  opens), all synced at T0. */
async function gameRoom(names: string[], root = rootFor()): Promise<Page[]> {
  beating = [];
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  const [a] = pages;
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(`ses:${TABLE}:${G.inc}:${nextSid3(G, root.value)}`, new Y.Map());
  });
  sync(T0, ...pages);
  runBare(pages, T0, T0, { step: STEP }); // (awake)
  return pages;
}

/** The game at the second table opens in page a's doc too: its root, and the session it opens. The root names
 *  house `h`, the second table's. */
function openSecond(a: Page, h: TestHouse = H2): void {
  const root = rootOf(G2, 'p', { dl: delegation(owner, h.pub, PAGE_ROOM) });
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(`ses:${T2}:${G2.inc}:${nextSid3(G2, root.value)}`, new Y.Map());
  });
}

/** A house checkpoint at round `u`, the commitment of round u + 1 in it unless `patch` says otherwise. */
const trimAt = (u: number, patch: Record<string, unknown> = {}) =>
  trimOf(G, 'p', { b: SID, u, l: hex('b', 32), d: `h:${hex('c', 32)}`, n: {}, h: kit.houseCommit(H, u + 1), dl: delegation(owner, H.pub, PAGE_ROOM), ...patch });

/** The checkpoints `cks` in page a's doc, the last the base: the game's first session is gone, and the base opens one. */
function baseOf(a: Page, ...cks: ReturnType<typeof trimAt>[]): string {
  const sid = nextSid3(G, cks[cks.length - 1].value);
  a.doc.transact(() => {
    for (const ck of cks) top(a).set(ck.key, ck.value);
    for (const key of [...top(a).keys()]) if (key.startsWith(`ses:${TABLE}:${G.inc}:`)) top(a).delete(key);
    top(a).set(`ses:${TABLE}:${G.inc}:${sid}`, new Y.Map());
  });
  return sid;
}

/** The owner ends game `ctx` (the fin and the end checkpoint, which it returns). */
function endGame(a: Page, ctx = G) {
  const end = trimOf(ctx, 'p', { ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(ctx, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {} });
  a.doc.transact(() => top(a).set(end.key, end.value));
  return end;
}

/** The game handed from the owner to the buyer after round `u` (the deed offer is of the page kit's room). */
const handOver = (u = 1) => xferOf(G, owner, buyer, u, { asset: { kind: 'deed', roomId: PAGE_ROOM, roomName: 'Furlong' } });

/** A and B bet on round `r` of the game (A red 10, B black 20), the houses' `recs` in its session, all synced at T. */
function bet(a: Page, b: Page, T: number, ...recs: Built<unknown>[]): void {
  if (recs.length > 0) house(a, ...recs);
  expect(a.table.writeComputedSlip(TABLE, [red(10)], T)).toBe('ok');
  expect(b.table.writeComputedSlip(TABLE, [black(20)], T)).toBe('ok');
  sync(T, a, b);
}

describe('the house a close depends on (computedHouse, on results made by hand)', () => {
  /** A round of a result: decided by a house reveal signed by `house`, or by none. */
  const round = (house?: string) => ({ house: house === undefined ? undefined : { rec: { k: house } } });
  /** The parts of a fold result these rules read: what is required, the rounds and the tip, the joins (signer, commitment). */
  const resOf = (p: { required?: string | null; tip?: object | null; rounds?: object[]; joins?: [string, string][] }): FoldResult =>
    ({ required: p.required ?? null, tip: p.tip ?? null, rounds: p.rounds ?? [], joins: (p.joins ?? []).map(([k, c]) => ({ rec: { k, c } })) }) as unknown as FoldResult;
  const yes = () => true;

  it('committingHouse: none while nothing is required, whoever decided the rounds before', () => {
    expect(committingHouse(resOf({ rounds: [round('h1')] }), 'base', yes)).toBeUndefined();
    expect(committingHouse(resOf({}), 'base', yes)).toBeUndefined();
  });

  it('committingHouse: the signer of the last round decided; the open round\'s own close (the tip, last of the rounds) decided nothing', () => {
    const rounds = [round('h1'), round('h2')];
    expect(committingHouse(resOf({ required: 'c', rounds }), 'base', yes)).toBe('h2');
    expect(committingHouse(resOf({ required: 'c', rounds, tip: {} }), 'base', yes)).toBe('h1');
    expect(committingHouse(resOf({ required: 'c', rounds: [round('h1')] }), 'base', yes)).toBe('h1');
  });

  it('committingHouse: with no round decided, the house that signed the base, and none when the base names none', () => {
    expect(committingHouse(resOf({ required: 'c' }), 'base', yes)).toBe('base');
    expect(committingHouse(resOf({ required: 'c', rounds: [round('h1')], tip: {} }), 'base', yes)).toBe('base');
    expect(committingHouse(resOf({ required: 'c' }), undefined, yes)).toBeUndefined();
    // (a round decided by no house reveal names none, and the base's house is not asked in its place)
    expect(committingHouse(resOf({ required: 'c', rounds: [round()] }), 'base', yes)).toBeUndefined();
  });

  it('committingHouse: only while the house is one of the game\'s for the open round, which is asked of that house alone', () => {
    const asked: string[] = [];
    const only = (...pubs: string[]) => (pub: string) => (asked.push(pub), pubs.includes(pub));
    expect(committingHouse(resOf({ required: 'c', rounds: [round('h1')] }), 'base', only('base'))).toBeUndefined();
    expect(committingHouse(resOf({ required: 'c' }), 'base', only('h1'))).toBeUndefined();
    expect(committingHouse(resOf({ required: 'c', rounds: [round('h1')] }), 'base', only('h1'))).toBe('h1');
    expect(committingHouse(resOf({ required: 'c' }), 'base', only('base'))).toBe('base');
    expect(asked).toEqual(['h1', 'base', 'h1', 'base']);
  });

  it('houseOfCommit: the committing house for the commitment required, the signer of the join for a join of the open round, none otherwise', () => {
    const required = resOf({ required: 'c' });
    expect(houseOfCommit(required, 'h1', 'c')).toBe('h1');
    expect(houseOfCommit(required, undefined, 'c')).toBeUndefined();
    // (a commitment the fold counts nowhere for the open round has no house, even with a house committing)
    expect(houseOfCommit(required, 'h1', 'elsewhere')).toBeUndefined();
    expect(houseOfCommit(required, 'h1', undefined)).toBeUndefined();
    const joined = resOf({ joins: [['j1', 'c1'], ['j2', 'c2'], ['j3', 'c3']] });
    expect(houseOfCommit(joined, undefined, 'c1')).toBe('j1');
    expect(houseOfCommit(joined, undefined, 'c2')).toBe('j2');
    expect(houseOfCommit(joined, undefined, 'c3')).toBe('j3');
    expect(houseOfCommit(joined, undefined, 'elsewhere')).toBeUndefined();
    expect(houseOfCommit(joined, undefined, undefined)).toBeUndefined();
  });

  it('commitHouses: the committing house, then the signers of the joins, each key once', () => {
    expect(commitHouses(resOf({ required: 'c' }), 'h1')).toEqual(['h1']);
    expect(commitHouses(resOf({ required: 'c' }), undefined)).toEqual([]);
    expect(commitHouses(resOf({ joins: [['j1', 'c1'], ['j2', 'c2']] }), undefined)).toEqual(['j1', 'j2']);
    expect(commitHouses(resOf({ joins: [['j1', 'c1'], ['j2', 'c2']] }), 'h1')).toEqual(['h1', 'j1', 'j2']);
    expect(commitHouses(resOf({ joins: [['j1', 'c1'], ['j1', 'c2'], ['j2', 'c3']] }), 'j2')).toEqual(['j2', 'j1']);
  });
});

describe('the beats a page counts', () => {
  it('counts the beat of a house whose join the game counted, from the next one that comes in: the beat in the doc is of any age', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    beatIn(a, T0, H, 1);
    sync(T0, a, b);
    for (const p of [a, b]) {
      expect(housesOf(p)).toEqual([]);
      expect(heard(p, H.pub, T0)).toBe(false);
    }
    house(a, kit.houseJoin(H, 1));
    sync(T0 + 1_000, a, b);
    for (const p of [a, b]) {
      expect(housesOf(p)).toEqual([H.pub]);
      expect(heard(p, H.pub, T0 + 1_000)).toBe(false); // (the beat that came before the join is not counted)
    }
    beatIn(a, T0 + 5_000, H, 2);
    sync(T0 + 5_000, a, b);
    for (const p of [a, b]) {
      expect(heard(p, H.pub, T0 + 5_000)).toBe(true);
      expect(heard(p, H.pub, T0 + 5_000 + HOUSE_HEARD_MS)).toBe(true);
      expect(heard(p, H.pub, T0 + 5_000 + HOUSE_HEARD_MS + 1)).toBe(false);
      // (a clock gone back reads the house as heard: it can't say for how long it wasn't, as the room's houseOnline reads its houses)
      expect(heard(p, H.pub, T0 + 5_000 - 60_000)).toBe(true);
    }
  });

  it('drops the beat of a key no game hears, a forged one, and one no newer than the last', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    beatIn(a, T0 + 1_000, STRANGER, 1);
    expect(heard(a, STRANGER.pub, T0 + 1_000)).toBe(false);
    // (a beat that names H and is signed by another key)
    const forged = { v: 1 as const, n: 1, k: H.pub };
    a.doc.transact(() => top(a).set(`hb:${H.pub}`, { ...forged, g: houseSign(H2.secret, roomSignBytes('hbeat', PAGE_ROOM, '', forged)) }));
    expect(heard(a, H.pub, T0 + 1_000)).toBe(false);
    beatIn(a, T0 + 2_000, H, 7);
    expect(heard(a, H.pub, T0 + 2_000)).toBe(true);
    // (a replay of an older count, and the same count again, move nothing: the time of the last stands)
    beatIn(a, T0 + 12_000, H, 3);
    beatIn(a, T0 + 12_000, H, 7);
    expect(heard(a, H.pub, T0 + 2_000 + HOUSE_HEARD_MS)).toBe(true);
    expect(heard(a, H.pub, T0 + 2_000 + HOUSE_HEARD_MS + 1)).toBe(false);
    beatIn(a, T0 + 13_000, H, 8);
    expect(heard(a, H.pub, T0 + 13_000 + HOUSE_HEARD_MS)).toBe(true);
  });

  it('is no house of the room: the beats of a game\'s house make neither the room\'s houses heard nor online', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    beatIn(a, T0 + 1_000, H, 1);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
    expect(a.casino.houseHeardAt()).toBeNull();
    expect(a.casino.houseOnline(T0 + 1_000)).toBe(false);
  });

  it('is heard from the room\'s own house, with no game naming it, only while the deed stays with the holder that pinned it', async () => {
    const [a] = await gameRoom(['A']);
    // (page A holds the deed, and its node's key H2 is delegated on its next house duty: a house of the room)
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid));
    a.table.setLocalHouse(H2.pub);
    const at = runBare([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.casino.houseOkOf(H2.pub)).toBe(true);
    expect(housesOf(a)).toEqual([]);
    beatIn(a, at, H2, 1);
    expect(a.casino.houseOnline(at)).toBe(true);
    expect(heard(a, H2.pub, at)).toBe(true);
    // the deed moves: the key is the room's house no longer, and no game names it
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', 'someone-else'));
    expect(a.casino.houseOnline(at)).toBe(false);
    expect(heard(a, H2.pub, at)).toBe(false);
  });

  it('is heard by the room from its newest beat: of two houses the deed holder pinned, the later beat counts', async () => {
    const [a] = await gameRoom(['A']);
    pinHouses(a, H, H2);
    expect(a.casino.houseOkOf(H.pub)).toBe(true);
    expect(a.casino.houseOkOf(H2.pub)).toBe(true);
    beatIn(a, T0 + 1_000, H, 1);
    beatIn(a, T0 + 4_000, H2, 1);
    expect(a.casino.houseHeardAt()).toBe(T0 + 4_000);
    beatIn(a, T0 + 6_000, H, 2);
    expect(a.casino.houseHeardAt()).toBe(T0 + 6_000);
    expect(a.casino.houseOnline(T0 + 6_000 + HOUSE_HEARD_MS)).toBe(true);
    expect(a.casino.houseOnline(T0 + 6_000 + HOUSE_HEARD_MS + 1)).toBe(false);
  });

  it('is heard until the last of the games that hear a key stops: one ending leaves its beat counted for the other', async () => {
    const [a] = await gameRoom(['A']);
    openSecond(a, H); // (the same house at both tables)
    house(a, kit.houseJoin(H, 1));
    const second = kit2.houseJoin(H, 1);
    putIn(a, [[second.key, second.rec]], T2);
    expect(housesOf(a)).toEqual([H.pub]);
    expect(housesOf(a, T2, G2.inc)).toEqual([H.pub]);
    beatIn(a, T0 + 1_000, H, 1);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
    endGame(a, G2);
    expect(housesOf(a, T2, G2.inc)).toEqual([]);
    expect(housesOf(a)).toEqual([H.pub]);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
    endGame(a, G);
    expect(housesOf(a)).toEqual([]);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(false);
  });

  it('keeps the beat of a key the deed holder pinned when the last game that hears it stops: it is the room\'s house all the same', async () => {
    const [a] = await gameRoom(['A']);
    // (the deed holder is the owner, whose key delegated H for the room as well as for the game)
    pinHouses(a, H);
    expect(a.casino.houseOkOf(H.pub)).toBe(true);
    house(a, kit.houseJoin(H, 1));
    expect(housesOf(a)).toEqual([H.pub]);
    beatIn(a, T0 + 1_000, H, 1);
    expect(a.casino.houseOnline(T0 + 1_000)).toBe(true);
    endGame(a);
    expect(housesOf(a)).toEqual([]);
    expect(a.casino.houseOnline(T0 + 1_000)).toBe(true);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
  });

  it('forgets with the doc: a doc bound again hears through its own count, and a game ending in it leaves nothing heard', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    beatIn(a, T0 + 1_000, H, 1);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
    rebind(a);
    runBare([a], T0 + 2_000, T0 + 3_000, { step: STEP });
    expect(housesOf(a)).toEqual([H.pub]);
    expect(heard(a, H.pub, T0 + 3_000)).toBe(false);
    beatIn(a, T0 + 4_000, H, 1);
    expect(heard(a, H.pub, T0 + 4_000)).toBe(true);
    endGame(a);
    expect(housesOf(a)).toEqual([]);
    expect(heard(a, H.pub, T0 + 4_000)).toBe(false);
  });

  it('forgets the count of a key no game hears any more: a moment after, it is heard from the next beat that comes in, and the record it left in the doc written again is one', async () => {
    const [a] = await gameRoom(['A']);
    const join = kit.houseJoin(H, 1);
    house(a, join);
    beatIn(a, T0 + 1_000, H, 1);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
    // (the join goes, and nothing the game holds names a house)
    deleteIn(a, [join.key]);
    expect(housesOf(a)).toEqual([]);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(false);
    // (it is written again a moment after: the house is one of the game's again, and the page has heard none of it since)
    clockOf(a, T0 + 2_000);
    house(a, join);
    expect(housesOf(a)).toEqual([H.pub]);
    expect(heard(a, H.pub, T0 + 2_000)).toBe(false);
    // (a peer writes the beat the doc kept again: it is the next that comes in, the limit above, here for a key whose count was dropped)
    const key = `hb:${H.pub}`;
    a.doc.transact(() => top(a).set(key, top(a).get(key)));
    expect(heard(a, H.pub, T0 + 2_000)).toBe(true);
  });
});

describe('the keys a game is heard through', () => {
  it('the house the base names, with no round decided yet: no join needed', async () => {
    const [a] = await gameRoom(['A']);
    baseOf(a, trimAt(1));
    expect(foldOf(a)).toMatchObject({ required: kit.houseCommit(H, 2), joins: [] });
    expect(housesOf(a)).toEqual([H.pub]);
    beatIn(a, T0 + 1_000, H, 1);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
  });

  it('none from a base that names no house: a holder\'s own checkpoint, a sweep another house signed', async () => {
    const [a] = await gameRoom(['A']);
    // (the owner's own checkpoint carries a commitment, and no house signed it)
    baseOf(a, trimAt(1, { h: hex('e', 64), k: owner.pub, dl: undefined }));
    expect(foldOf(a)).toMatchObject({ required: hex('e', 64), joins: [] });
    expect(housesOf(a)).toEqual([]);
    // (a sweep of a house's checkpoint by the holder's other house: its commitment is the first house's, not the sweeper's)
    const [c] = await gameRoom(['C']);
    const trim = trimAt(1);
    baseOf(c, trim, trimAt(1, { b: nextSid3(G, trim.value), w: 1, k: H2.pub, dl: delegation(owner, H2.pub, PAGE_ROOM) }));
    expect(c.casino.computedResolutionOf(TABLE, G.inc)?.base?.ck).toMatchObject({ w: 1, k: H2.pub });
    expect(foldOf(c)).toMatchObject({ required: kit.houseCommit(H, 2), joins: [] });
    expect(housesOf(c)).toEqual([]);
  });

  it('every house that joined the open round, and the one that decided the round before once it has: the others are forgotten', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    top(a).set(`hk:${H2.pub}`, delegation(owner, H2.pub, PAGE_ROOM));
    const joins = [kit.houseJoin(H, 1), kit.houseJoin(H2, 1)].sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const first = joins[0].rec.k === H.pub ? H : H2;
    const second = first === H ? H2 : H;
    house(a, ...joins);
    expect(housesOf(a)).toEqual([H.pub, H2.pub].sort());
    for (const h of [H, H2]) beatIn(a, T0 + 1_000, h, 1);
    expect(heard(a, first.pub, T0 + 1_000)).toBe(true);
    expect(heard(a, second.pub, T0 + 1_000)).toBe(true);
    // the first one's reveal decides round 1: the next round must name its commitment, and the other is not heard now
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, a, b);
    beating = [new Beating(a, first)];
    const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    expect(close.h).toBe(joins[0].rec.c);
    run([a, b], closedAt + STEP, closedAt + 3_000, { step: STEP });
    const kitReveal = kit.houseReveal(first, 1, [hashIn(keysIn(a, 'c', 1)[0])], Object.values(close.f).sort());
    house(b, kitReveal);
    sync(closedAt + 3_000, a, b);
    for (const p of [a, b]) {
      expect(foldOf(p).required).toBe(kit.houseCommit(first, 2));
      expect(housesOf(p)).toEqual([first.pub]);
      expect(heard(p, second.pub, closedAt + 3_000)).toBe(false); // (it beat a moment ago: forgotten with its place)
    }
    beatIn(a, closedAt + 4_000, second, 2);
    expect(heard(a, second.pub, closedAt + 4_000)).toBe(false);
    // (the game ends: the one house left in its set is let go of with the game, whatever the set went through, and its beat is dropped)
    expect(heard(a, first.pub, closedAt + 4_000)).toBe(true);
    endGame(a);
    expect(housesOf(a)).toEqual([]);
    expect(heard(a, first.pub, closedAt + 4_000)).toBe(false);
  });

  it('none once the game has ended: the keys it heard are forgotten, and their beats are dropped', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    beatIn(a, T0 + 1_000, H, 1);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(true);
    const end = endGame(a);
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: false });
    expect(housesOf(a)).toEqual([]);
    expect(heard(a, H.pub, T0 + 1_000)).toBe(false);
    beatIn(a, T0 + 2_000, H, 2);
    expect(heard(a, H.pub, T0 + 2_000)).toBe(false);
    // (a house joins a round past the end, in the session the end checkpoint opens: the fold lists no join of a game that has ended, and none is heard)
    const next = `ses:${TABLE}:${G.inc}:${nextSid3(G, end.value)}`;
    const join = kit.houseJoin(H, 6);
    a.doc.transact(() => {
      top(a).set(next, new Y.Map());
      (top(a).get(next) as Y.Map<unknown>).set(join.key, join.rec);
    });
    expect(a.casino.computedFoldOf(TABLE, G.inc)).toMatchObject({ open: 6, required: null, joins: [] });
    expect(housesOf(a)).toEqual([]);
    beatIn(a, T0 + 3_000, H, 3);
    expect(heard(a, H.pub, T0 + 3_000)).toBe(false);
  });

  it('none from a game handed over for the seller\'s house, whichever checkpoint of the two stands: the commitment it carries is no house\'s now', async () => {
    for (const adopted of [false, true]) {
      const [a] = await gameRoom(['A']);
      const trim = trimAt(1);
      const xf = handOver();
      // (the buyer's own key is a house of its game too: the adoption it signed is no house's trim, all the same)
      a.doc.transact(() => top(a).set(`hk:${buyer.pub}`, delegation(buyer, buyer.pub, PAGE_ROOM)));
      if (adopted) baseOf(a, trimAt(1, { k: buyer.pub, dl: undefined, x: [xf.value] }));
      else {
        baseOf(a, trim);
        a.doc.transact(() => top(a).set(xf.key, xf.value));
      }
      expect(a.casino.computedResolutionOf(TABLE, G.inc), `adopted ${adopted}`).toMatchObject({ holder: buyer.pub, live: true });
      expect(foldOf(a).required, `adopted ${adopted}`).toBe(kit.houseCommit(H, 2));
      expect(housesOf(a), `adopted ${adopted}`).toEqual([]);
    }
  });
});

describe('the close waits for the house it names', () => {
  it('is not written while the house the join named is not heard, whoever else beats, and is within a turn of its beat', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0, kit.houseJoin(H, 1));
    // (a key no game hears, and a house of another game, beat all the while: neither stands in for it)
    beating = [new Beating(a, STRANGER), new Beating(a, H2)];
    const quiet = run([a, b], T0 + STEP, T0 + 60_000, { step: STEP });
    for (const p of [a, b]) expect(keysIn(p, 'c', 1)).toEqual([]);
    expect(heard(a, H2.pub, quiet)).toBe(false);
    beating.push(new Beating(a, H));
    const closedAt = run([a, b], quiet, quiet + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + a.table.STAGGER_MS + STEP * 2);
    expect(closesOf(a, 1)[0].h).toBe(kit.houseJoin(H, 1).rec.c);
  });

  it('is not written on a beat older than HOUSE_HEARD_MS: the window runs out after the house was last heard, and a fresh beat lets it through', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0, kit.houseJoin(H, 1));
    const beatAt = run([a, b], T0 + STEP, T0 + 1_000, { step: STEP });
    beatIn(a, beatAt, H, 1); // (heard until beatAt + HOUSE_HEARD_MS, before the bets' window runs out)
    const window = a.table.BET_WINDOW_MS;
    expect(beatAt + HOUSE_HEARD_MS).toBeLessThan(T0 + window);
    const quiet = run([a, b], beatAt, T0 + window + 20_000, { step: STEP });
    for (const p of [a, b]) expect(keysIn(p, 'c', 1)).toEqual([]);
    beatIn(a, quiet, H, 2);
    const closedAt = run([a, b], quiet, quiet + 10_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + a.table.STAGGER_MS + STEP * 2);
  });

  it('waits for the one house the first join names when two joined it: the other beating alone is no help, the room\'s own houses included', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    // (both are the deed holder's houses as well: the room has a house online all the while, which is none of this game's to wait for)
    pinHouses(a, H, H2);
    const joins = [kit.houseJoin(H, 1), kit.houseJoin(H2, 1)].sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const first = joins[0].rec.k === H.pub ? H : H2;
    const second = first === H ? H2 : H;
    bet(a, b, T0, ...joins);
    beating = [new Beating(a, second)];
    const quiet = run([a, b], T0 + STEP, T0 + 60_000, { step: STEP });
    for (const p of [a, b]) expect(keysIn(p, 'c', 1)).toEqual([]);
    expect(heard(a, second.pub, quiet)).toBe(true);
    expect(a.casino.houseOnline(quiet)).toBe(true);
    beating.push(new Beating(a, first));
    run([a, b], quiet, quiet + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1)[0].h).toBe(joins[0].rec.c);
  });

  it('waits for the house the base names at the first round of a session, and no other', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    baseOf(a, trimAt(1));
    sync(T0, a, b);
    const at = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    bet(a, b, at);
    beating = [new Beating(a, STRANGER)];
    const quiet = run([a, b], at + STEP, at + 60_000, { step: STEP });
    for (const p of [a, b]) expect(keysIn(p, 'c', 2)).toEqual([]);
    beating.push(new Beating(a, H));
    run([a, b], quiet, quiet + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2)[0].h).toBe(kit.houseCommit(H, 2));
  });

  it('is written with no house heard when the page can\'t tell the house: a base no house signed, a sweep, a game handed over', async () => {
    const cases: [string, (a: Page) => void][] = [
      ['a holder\'s own checkpoint', (a) => void baseOf(a, trimAt(1, { h: hex('e', 64), k: owner.pub, dl: undefined }))],
      ['a sweep of another house', (a) => {
        const trim = trimAt(1);
        baseOf(a, trim, trimAt(1, { b: nextSid3(G, trim.value), w: 1, k: H2.pub, dl: delegation(owner, H2.pub, PAGE_ROOM) }));
      }],
      ['the seller\'s checkpoint of a game handed over', (a) => {
        baseOf(a, trimAt(1));
        const xf = handOver();
        a.doc.transact(() => top(a).set(xf.key, xf.value));
      }],
    ];
    for (const [label, open] of cases) {
      const [a, b] = await gameRoom(['A', 'B']);
      open(a);
      sync(T0, a, b);
      const at = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
      bet(a, b, at);
      const closedAt = run([a, b], at + STEP, at + 60_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
      expect(closedAt, label).toBeLessThanOrEqual(at + a.table.BET_WINDOW_MS + a.table.STAGGER_MS * 3);
      expect(closesOf(a, 2)[0].h, label).toBe(foldOf(a).required);
    }
  });

  it('is not written on the beat a doc bound later still holds, of any age: the page waits for the next that comes in', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    beatIn(a, T0, H, 1); // (its node died long ago; its last beat stays in the doc)
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    rebind(a);
    const quiet = run([a], T0 + STEP, T0 + a.table.BET_WINDOW_MS + 30_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
    beatIn(a, quiet, H, 2);
    const closedAt = run([a], quiet, quiet + 10_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + a.table.STAGGER_MS + STEP * 2);
  });

  it('counts the record the doc holds written again by a peer as a beat that comes in: a limit, for a beat is a counter and the doc keeps no time', async () => {
    const [a] = await gameRoom(['A']);
    house(a, kit.houseJoin(H, 1));
    beatIn(a, T0, H, 1); // (its node died long ago; its last beat stays in the doc)
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    rebind(a);
    const quiet = run([a], T0 + STEP, T0 + a.table.BET_WINDOW_MS + 30_000, { step: STEP });
    expect(keysIn(a, 'c', 1)).toEqual([]);
    // (a peer with no key of the house's writes the record again, byte for byte: the page has no count for the key, and takes it for a beat)
    clockOf(a, quiet);
    const key = `hb:${H.pub}`;
    a.doc.transact(() => top(a).set(key, top(a).get(key)));
    expect(heard(a, H.pub, quiet)).toBe(true);
    const closedAt = run([a], quiet, quiet + 10_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + a.table.STAGGER_MS + STEP * 2);
    // (only for HOUSE_HEARD_MS: a page that has a count for the key ignores the same record again)
    expect(heard(a, H.pub, quiet + HOUSE_HEARD_MS + STEP)).toBe(false);
    a.doc.transact(() => top(a).set(key, top(a).get(key)));
    expect(heard(a, H.pub, quiet + HOUSE_HEARD_MS + STEP)).toBe(false);
  });
});

describe('an abandon waits for the house whose commitment the close names', () => {
  /** A and B bet and the house joined and beats; a bettor closed round 1 and both seeds are in. The house never reveals. */
  async function closed() {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0, kit.houseJoin(H, 1));
    beating = [new Beating(a, H)];
    const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    return { a, b, closedAt, closeHash: hashIn(keysIn(a, 'c', 1)[0]) };
  }
  /** The bettor whose turn comes first at round r. */
  const firstOf = (a: Page, b: Page, r = 1): Page => (dutyRank('abandon', G, r, a.pub) < dutyRank('abandon', G, r, b.pub) ? a : b);

  it('waits ABANDON_MS while the house is heard, and a bettor writes it then', async () => {
    const { a, b, closedAt, closeHash } = await closed();
    const first = firstOf(a, b);
    const at = run([a, b], closedAt + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(first, 'z', 1).length > 0 });
    expect(at).toBeGreaterThanOrEqual(closedAt + a.table.ABANDON_MS);
    expect(at).toBeLessThanOrEqual(closedAt + a.table.ABANDON_MS + STEP * 3);
    const [z] = keysIn(first, 'z', 1);
    expect(asAbandon(first.casino.computedSessionForWrite(TABLE)!.get(z))).toMatchObject({ r: 1, x: closeHash, k: first.pub });
  });

  it('waits only until the house has been silent for HOUSE_HEARD_MS: the wait follows its last beat', async () => {
    const { a, b, closedAt } = await closed();
    const first = firstOf(a, b);
    run([a, b], closedAt + STEP, closedAt + 10_000, { step: STEP });
    const lastBeat = beating[0].lastAt!;
    beating[0].muted = true;
    const at = run([a, b], closedAt + 10_000 + STEP, closedAt + 60_000, { step: STEP, until: () => keysIn(first, 'z', 1).length > 0 });
    expect(at).toBeGreaterThan(lastBeat + HOUSE_HEARD_MS);
    expect(at).toBeLessThanOrEqual(lastBeat + HOUSE_HEARD_MS + STEP * 3);
    expect(at).toBeLessThan(closedAt + a.table.ABANDON_MS);
  });

  it('waits ABANDON_MS for a house the page can\'t tell: the close names a commitment no house of the game carried', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    baseOf(a, trimAt(1, { h: hex('e', 64), k: owner.pub, dl: undefined }));
    sync(T0, a, b);
    const at = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    bet(a, b, at);
    const closedAt = run([a, b], at + STEP, at + 60_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    const first = firstOf(a, b, 2);
    const voidAt = run([a, b], closedAt + STEP, closedAt + 90_000, { step: STEP, until: () => keysIn(first, 'z', 2).length > 0 });
    expect(voidAt).toBeGreaterThanOrEqual(closedAt + a.table.ABANDON_MS);
    expect(voidAt).toBeLessThanOrEqual(closedAt + a.table.ABANDON_MS + STEP * 3);
  });

  it('follows the join its close names, which is not always the first: a house joined after the close was written', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    top(a).set(`hk:${H2.pub}`, delegation(owner, H2.pub, PAGE_ROOM));
    const [lo, hi] = [kit.houseJoin(H, 1), kit.houseJoin(H2, 1)].sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const [loHouse, hiHouse] = lo.rec.k === H.pub ? [H, H2] : [H2, H];
    bet(a, b, T0, hi); // (the later join alone when the close is written: it names that one)
    beating = [new Beating(a, hiHouse)];
    const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(closesOf(a, 1)[0].h).toBe(hi.rec.c);
    house(a, lo); // (then the earlier join comes: the first of the round now)
    sync(closedAt, a, b);
    for (const p of [a, b]) expect(foldOf(p).joins.map((j) => j.rec.c)).toEqual([lo.rec.c, hi.rec.c]);
    // (the house the close names falls silent while the first join's beats on)
    beating[0].muted = true;
    beating.push(new Beating(a, loHouse));
    const first = firstOf(a, b);
    const at = run([a, b], closedAt + STEP, closedAt + 90_000, { step: STEP, until: () => keysIn(first, 'z', 1).length > 0 });
    expect(at).toBeGreaterThanOrEqual(closedAt + HOUSE_HEARD_MS);
    expect(at).toBeLessThan(closedAt + a.table.ABANDON_MS);
  });

  it('follows the house that decided the round before when the open round has its close in: that close decided nothing', async () => {
    const { a, b, closedAt, closeHash } = await closed();
    const [close] = closesOf(a, 1);
    run([a, b], closedAt + STEP, closedAt + 12_000, { step: STEP });
    house(b, kit.houseReveal(H, 1, [closeHash], Object.values(close.f).sort()));
    sync(closedAt + 12_000, a, b);
    // (round 2, once the result has shown its 9 s from the reveal: its close names the commitment the reveal carried)
    const at = closedAt + 22_000;
    run([a, b], closedAt + 12_000 + STEP, at, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(5)], at)).toBe('ok');
    sync(at, a, b);
    const closed2 = run([a, b], at + STEP, at + 30_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    for (const p of [a, b]) {
      expect(foldOf(p).tip).toMatchObject({ r: 2, decided: null });
      expect(foldOf(p).required).toBe(kit.houseCommit(H, 2));
      expect(housesOf(p)).toEqual([H.pub]);
    }
    run([a, b], closed2 + STEP, closed2 + 3_000, { step: STEP });
    const lastBeat = beating[0].lastAt!;
    beating[0].muted = true;
    const voidAt = run([a, b], closed2 + 3_000 + STEP, closed2 + 90_000, { step: STEP, until: () => keysIn(a, 'z', 2).length > 0 });
    expect(voidAt).toBeGreaterThan(lastBeat + HOUSE_HEARD_MS);
    expect(voidAt).toBeLessThanOrEqual(lastBeat + HOUSE_HEARD_MS + STEP * 3);
    expect(voidAt).toBeLessThan(closed2 + a.table.ABANDON_MS);
  });
});

describe('a game handed over', () => {
  /** Round 1 of the game played and decided by H's reveal, all synced; the pages A and B, and the time. */
  async function decidedByH() {
    const [a, b] = await gameRoom(['A', 'B']);
    bet(a, b, T0, kit.houseJoin(H, 1));
    beating = [new Beating(a, H)];
    const closedAt = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    const [close] = closesOf(a, 1);
    run([a, b], closedAt + STEP, closedAt + 12_000, { step: STEP });
    house(b, kit.houseReveal(H, 1, [hashIn(keysIn(a, 'c', 1)[0])], Object.values(close.f).sort()));
    sync(closedAt + 12_000, a, b);
    for (const p of [a, b]) {
      expect(foldOf(p).required).toBe(kit.houseCommit(H, 2));
      expect(housesOf(p)).toEqual([H.pub]);
    }
    return { a, b, at: closedAt + 12_000 };
  }

  it('is held for a house of the seller\'s that decided a round before only for the rounds the seller still holds: not past a hand-over after the round before, still for the round it comes after', async () => {
    // (after round 1, the open round 2 is the buyer's: the seller's house is no house of it; after round 2, it is still the seller's)
    for (const [after, expected] of [[1, []], [2, [H.pub]]] as const) {
      const { a, b, at } = await decidedByH();
      const xf = handOver(after);
      a.doc.transact(() => top(a).set(xf.key, xf.value));
      sync(at + STEP, a, b);
      for (const p of [a, b]) {
        expect(p.casino.computedResolutionOf(TABLE, G.inc), `after ${after}`).toMatchObject({ holder: buyer.pub, live: true });
        expect(foldOf(p), `after ${after}`).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
        expect(housesOf(p), `after ${after}`).toEqual(expected);
      }
    }
  });

  it('is held again for a seller\'s house the buyer delegates, once that delegation is checked and not before', async () => {
    const { a, b, at } = await decidedByH();
    const xf = handOver(1);
    a.doc.transact(() => top(a).set(xf.key, xf.value));
    sync(at + STEP, a, b);
    expect(housesOf(a)).toEqual([]);
    // (the buyer keeps the node: the key is delegated again by the holder now, with no time to check the delegation when it comes)
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    a.doc.transact(() => top(a).set(`hk:${H.pub}`, delegation(buyer, H.pub, PAGE_ROOM)));
    expect(housesOf(a)).toEqual([]);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(housesOf(a)).toEqual([H.pub]);
    expect(foldOf(a)).toMatchObject({ open: 2, required: kit.houseCommit(H, 2) });
  });

  it('waits for no slice once the delegation it waited for is checked: asking for the slice that checks what waited queues none', async () => {
    const { a, b, at } = await decidedByH();
    const xf = handOver(1);
    a.doc.transact(() => top(a).set(xf.key, xf.value));
    sync(at + STEP, a, b);
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    a.doc.transact(() => top(a).set(`hk:${H.pub}`, delegation(buyer, H.pub, PAGE_ROOM)));
    expect(housesOf(a)).toEqual([]);
    // (the game waits for the delegation's check: this queues the slice that makes it, and the game is counted again in it)
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    for (let i = 0; i < 3; i++) await turn();
    expect(housesOf(a)).toEqual([H.pub]);
    // (nothing waits now: the same asking queues no slice, and no transaction follows)
    let transactions = 0;
    a.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    for (let i = 0; i < 5; i++) await turn();
    expect(transactions).toBe(0);
  });

  it('is not held for the seller\'s house: the close names its commitment, an abandon voids it, and the round after waits for the buyer\'s house', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    baseOf(a, trimAt(1));
    const xf = handOver();
    a.doc.transact(() => top(a).set(xf.key, xf.value));
    // (the seller's house is silent: no beat of it, or of anyone, is ever written until the buyer's house comes)
    sync(T0, a, b);
    const at = run([a, b], T0 + STEP, T0 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    bet(a, b, at);
    const closedAt = run([a, b], at + STEP, at + 60_000, { step: STEP, until: () => keysIn(a, 'c', 2).length > 0 });
    expect(closesOf(a, 2)[0].h).toBe(kit.houseCommit(H, 2));
    const first = dutyRank('abandon', G, 2, a.pub) < dutyRank('abandon', G, 2, b.pub) ? a : b;
    const voidAt = run([a, b], closedAt + STEP, closedAt + 90_000, { step: STEP, until: () => keysIn(first, 'z', 2).length > 0 });
    expect(voidAt).toBeGreaterThanOrEqual(closedAt + a.table.ABANDON_MS);
    run([a, b], voidAt + STEP, voidAt + 3_000, { step: STEP });
    for (const p of [a, b]) expect(foldOf(p)).toMatchObject({ open: 3, required: null, joins: [] });
    // the buyer's house joins round 3, and the close waits for its beats: the seller's alone is none
    const delegated = delegation(buyer, H2.pub, PAGE_ROOM);
    top(a).set(`hk:${H2.pub}`, delegated);
    const join = kit.houseJoin(H2, 3);
    house(a, join);
    sync(voidAt + 3_000, a, b);
    for (const p of [a, b]) {
      expect(foldOf(p).joins.map((j) => j.rec.k)).toEqual([H2.pub]);
      expect(housesOf(p)).toEqual([H2.pub]);
    }
    const next = run([a, b], voidAt + 3_000 + STEP, voidAt + 3_000 + 30_000, { step: STEP, until: () => a.table.readComputedRoulette(TABLE)?.phase === 'betting' });
    bet(a, b, next);
    beating = [new Beating(a, H)];
    const quiet = run([a, b], next + STEP, next + 60_000, { step: STEP });
    for (const p of [a, b]) expect(keysIn(p, 'c', 3)).toEqual([]);
    beating.push(new Beating(a, H2));
    run([a, b], quiet, quiet + 30_000, { step: STEP, until: () => keysIn(a, 'c', 3).length > 0 });
    expect(closesOf(a, 3)[0].h).toBe(join.rec.c);
  });
});

describe('each table waits for its own game\'s house', () => {
  it('one house beating closes its table and not the other\'s', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    openSecond(a, H2);
    house(a, kit.houseJoin(H, 1));
    const second = kit2.houseJoin(H2, 1);
    putIn(a, [[second.key, second.rec]], T2);
    sync(T0, a, b);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(T2, [black(20)], T0)).toBe('ok');
    sync(T0, a, b);
    const tables = [TABLE, T2];
    beating = [new Beating(a, H)];
    const first = run([a, b], T0 + STEP, T0 + 40_000, { step: STEP, tables, until: () => keysIn(a, 'c', 1).length > 0 });
    // (the other table's window ran out long ago: it waits for H2 all the same)
    const quiet = run([a, b], first + STEP, first + 30_000, { step: STEP, tables });
    expect(keysIn(a, 'c', 1, T2)).toEqual([]);
    beating.push(new Beating(a, H2));
    run([a, b], quiet, quiet + 30_000, { step: STEP, tables, until: () => keysIn(a, 'c', 1, T2).length > 0 });
    expect(closesOf(a, 1, T2)[0].h).toBe(second.rec.c);
  });
});
