/**
 * 🔒🧮 A page counts a FAIR ONLY game (casinoDoc, `p…` roulette and `q…` craps;
 * design §8.3 S3–S8, PR 6c-4a-1): the records of a game it finds in a doc, the
 * checkpoint the authority resolver picks from them, the session that opens,
 * and what the fold makes of it, in the chip ledger and on the felts.
 *
 * A FAIR ONLY game keeps its checkpoints at the top level of `casinoComputed`
 * (`ck:`), beside its transfers (`xf:`) and its end order (`fin:`); the page
 * keeps them as the doc holds them, resolves the game (computedFairOnlyAuth)
 * and folds from the base that names. The specs write the records straight into
 * a doc, as the duties of a later PR will, and read what the page counts: the
 * ledger (`readChips`), the resolution (`computedResolutionOf`) and what waits
 * for a check (`computedSettled`). Each page is its own load of the casino
 * modules and its own Y.Doc, synced by hand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { nextSid3, TableFold } from './computedFold';
import type { FoldCtx, FoldResult, HouseCheck } from './computedFold';
import { delegationKey } from './computedHouse';
import { ckKey, faironlyInc, finKey, sealFin, sealXf, xfKey } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import {
  authEnv, buyer, changed, ctxOf, DL_HOUSE, delegation, fourth, hex, house, house2, NAME, owner, P, Q, rootOf, ROOM, stranger, T, third, trimOf, xferOf,
} from './computedFairOnlyKit';
import { black, cachingCheck, ComputedKit, housesAre, red, testIdentity } from './computedTestKit';
import type { Built, TestHouse, TestIdentity } from './computedTestKit';

void [authEnv, fourth, third, hex, delegation, xfKey, sealXf, finKey, sealFin, xferOf, buyer, stranger, house2, DL_HOUSE, changed, trimOf];

type Page = { casino: typeof import('./casinoDoc'); doc: Y.Doc };

vi.stubGlobal('window', { location: { search: '' } });

vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => 'page-owner',
}));

/** A page whose checks never run out of time (a fixed budget clock), so every
 *  transaction resolves and counts whole, however slow the machine. */
async function loadPage(clientID: number, verify: Parameters<Page['casino']['setComputedVerifyForTests']>[0] = { now: () => 0 }, fast = false): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  if (fast) expect(await (await import('./keypair')).enableFastStrictChecks()).toBe(true);
  const doc = new Y.Doc();
  doc.clientID = clientID;
  casino.setComputedVerifyForTests(verify);
  casino.bindCasinoDoc(doc, ROOM);
  return { casino, doc };
}

function sync(...pages: Page[]): void {
  for (const x of pages) {
    for (const y of pages) if (x !== y) Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc)));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(done: () => boolean, tries = 3_000): Promise<boolean> {
  for (let i = 0; i < tries && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  return done();
}

const realCrypto = globalThis.crypto;

/** The WebCrypto key imports and verifies made from here on, counted around the real ones. */
function countWebCrypto(): { imports: number; verifies: number } {
  const n = { imports: 0, verifies: 0 };
  vi.stubGlobal('crypto', {
    getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a),
    subtle: {
      importKey: (...a: Parameters<SubtleCrypto['importKey']>) => {
        n.imports += 1;
        return realCrypto.subtle.importKey(...a);
      },
      verify: (...a: Parameters<SubtleCrypto['verify']>) => {
        n.verifies += 1;
        return realCrypto.subtle.verify(...a);
      },
      digest: (...a: Parameters<SubtleCrypto['digest']>) => realCrypto.subtle.digest(...a),
    },
  });
  return n;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
  vi.restoreAllMocks();
});

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The same bytes, spelled differently: set a low bit the decoder throws away. */
const strayBit = (s: string): string => s.slice(0, -1) + B64[B64.indexOf(s[s.length - 1]) | 1];

const A = testIdentity('alice');
const B = testIdentity('bob');
const H: TestHouse = house;
const kit = new ComputedKit(P);
const root = rootOf(P, 'p');
const SID = nextSid3(P, root.value);
/** A second game at the same table (its name differs in `j`): its own incarnation, kit, root and first session. */
const P2 = ctxOf('p', T, { ...NAME, j: hex('2', 16) });
const kit2 = new ComputedKit(P2);
const root2 = rootOf(P2, 'p', { j: hex('2', 16) });
const SID2 = nextSid3(P2, root2.value);

/** The room's players map shows each identity's key: this page pins it. */
function pin(page: Page, ...ids: TestIdentity[]): void {
  page.doc.transact(() => {
    for (const id of ids) page.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

const casinoComputed = (page: Page): Y.Map<unknown> => page.doc.getMap<unknown>('casinoComputed');

/** Top-level records into the doc, in one transaction. */
function put(page: Page, ...recs: { key: string; value: unknown }[]): void {
  page.doc.transact(() => {
    for (const r of recs) casinoComputed(page).set(r.key, r.value);
  });
}

const sesKey = (ctx: FoldCtx, sid: string): string => `ses:${ctx.t}:${ctx.inc}:${sid}`;

/** Records into the session `sid` of a game (made if it isn't there), in one transaction. */
function putSession(page: Page, ctx: FoldCtx, sid: string, ...recs: Built<unknown>[]): void {
  page.doc.transact(() => {
    const map = casinoComputed(page);
    let ses = map.get(sesKey(ctx, sid));
    if (!(ses instanceof Y.Map)) map.set(sesKey(ctx, sid), (ses = new Y.Map<unknown>()));
    for (const r of recs) (ses as Y.Map<unknown>).set(r.key, r.rec);
  });
}

/** A house's checkpoint written as a trim writes one: the record, the sessions of the game
 *  gone, the next session there with `copies`. */
function trimTo(page: Page, ctx: FoldCtx, cp: { key: string; value: CkRec }, copies: Built<unknown>[] = []): void {
  page.doc.transact(() => {
    const map = casinoComputed(page);
    map.set(cp.key, cp.value);
    for (const key of [...map.keys()]) if (key.startsWith(`ses:${ctx.t}:${ctx.inc}:`)) map.delete(key);
    const ses = new Y.Map<unknown>();
    map.set(sesKey(ctx, nextSid3(ctx, cp.value)), ses);
    for (const r of copies) ses.set(r.key, r.rec);
  });
}

/** What the fold makes of a session from a base, with nothing of the page in it: the oracle. */
function foldOf(records: Built<unknown>[], base: CkRec = root.value, ctx: FoldCtx = P, check = cachingCheck().check, houses: HouseCheck = housesAre(H)): FoldResult {
  const fold = new TableFold(ctx, check, undefined, undefined, houses);
  fold.setFairOnlyBase(base);
  fold.reset(records.map((b) => [b.key, b.rec] as const));
  return fold.result();
}

/** Round 1 with Alice and Bob: the house's join, Alice's close naming it, both
 *  seeds, and the house's reveal counting both (it carries round 2's commitment). */
function roundOne(k: ComputedKit, sid: string) {
  const a1 = k.slip(A, 1, [red(10)]);
  const b1 = k.slip(B, 1, [black(5)]);
  const join = k.houseJoin(H, 1);
  const close = k.close(A, 1, sid, [a1, b1], join.rec.c);
  const ra = k.reveal(1, A.pid);
  const rb = k.reveal(1, B.pid);
  const hr = k.houseReveal(H, 1, [close.hash], [a1.hash, b1.hash]);
  return { a1, b1, join, close, ra, rb, hr, all: [a1, b1, join, close, ra, rb, hr] as Built<unknown>[] };
}
const round1 = () => roundOne(kit, SID);

/** A page with the game's root and round 1 in its doc, both players with 100 chips. */
async function openedPage(clientID = 1): Promise<{ page: Page; r1: ReturnType<typeof round1> }> {
  const page = await loadPage(clientID);
  page.casino.buyInChips(A.pid, 100);
  page.casino.buyInChips(B.pid, 100);
  pin(page, A, B);
  put(page, root);
  const r1 = round1();
  putSession(page, P, SID, ...r1.all);
  return { page, r1 };
}

const chips = (page: Page, id: TestIdentity): number => page.casino.readChips(id.pid);
const netOf = (res: FoldResult, id: TestIdentity): number => Number(res.nets.get(id.pid) ?? 0n);

const heldOf = (res: FoldResult, id: TestIdentity): number => Number(res.held.get(id.pid) ?? 0n);

/** Round 2 of the same two players, after round 1 (decided by the house's reveal): their slips,
 *  the close naming the commitment round 1's reveal carried, the seeds and the house's reveal. */
function round2(r1: ReturnType<typeof round1>) {
  const a2 = kit.slip(A, 2, [red(3)]);
  const b2 = kit.slip(B, 2, [black(4)]);
  const close = kit.close(A, 2, r1.close.hash, [a2, b2], kit.houseCommit(H, 2));
  const ra = kit.reveal(2, A.pid);
  const rb = kit.reveal(2, B.pid);
  const hr = kit.houseReveal(H, 2, [close.hash], [a2.hash, b2.hash]);
  return { a2, b2, close, ra, rb, hr, all: [a2, b2, close, ra, rb, hr] as Built<unknown>[] };
}

// ── What a page counts ───────────────────────────────────────────────────────

describe('a page counts a FAIR ONLY game it finds in a doc', () => {
  it('through a root, a session and a decided round: nets in the ledger, on the writing page and on one that hears it', async () => {
    const { page: a, r1 } = await openedPage();
    const res = foldOf(r1.all);
    expect(res.rounds.map((v) => v.decided)).toEqual(['house']);
    expect(netOf(res, A) + netOf(res, B)).not.toBe(0);
    const res0 = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res0).toMatchObject({ t: T, inc: P.inc, letter: 'p', live: true, pending: false, newer: false, holder: owner.pub, invalid: [] });
    expect(res0.base).toMatchObject({ key: root.key });
    expect(chips(a, A)).toBe(100 + netOf(res, A));
    expect(chips(a, B)).toBe(100 + netOf(res, B));
    const b = await loadPage(2);
    sync(a, b);
    expect(chips(b, A)).toBe(100 + netOf(res, A));
    expect(chips(b, B)).toBe(100 + netOf(res, B));
    expect(a.casino.computedSettled()).toBe(true);
    expect(b.casino.computedSettled()).toBe(true);
  });

  it('on a page bound to a doc that holds it already, as the room cache gives one', async () => {
    const { page: a, r1 } = await openedPage();
    const res = foldOf(r1.all);
    const late = await loadPage(3);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.doc));
    late.casino.bindCasinoDoc(copy, ROOM);
    expect(late.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, holder: owner.pub });
    expect(chips(late, A)).toBe(100 + netOf(res, A));
    expect(chips(late, B)).toBe(100 + netOf(res, B));
  });

  it('what the open round\'s felts hold comes off the player\'s chips, and a round decided puts it into the nets', async () => {
    const { page: a, r1 } = await openedPage();
    const net = foldOf(r1.all);
    const a2 = kit.slip(A, 2, [red(7)]);
    const b2 = kit.slip(B, 2, [black(9)]);
    putSession(a, P, SID, a2, b2);
    const held = foldOf([...r1.all, a2, b2]);
    expect(heldOf(held, A)).toBe(7);
    expect(heldOf(held, B)).toBe(9);
    expect(chips(a, A)).toBe(100 + netOf(net, A) - 7);
    expect(chips(a, B)).toBe(100 + netOf(net, B) - 9);
    // round 2 decided: the stakes are nets now, and nothing is held
    const r2 = round2(r1);
    putSession(a, P, SID, ...r2.all);
    const done = foldOf([...r1.all, a2, b2, ...r2.all]);
    expect(done.rounds.map((v) => v.decided)).toEqual(['house', 'house']);
    expect(chips(a, A)).toBe(100 + netOf(done, A));
    expect(chips(a, B)).toBe(100 + netOf(done, B));
  });

  it('a trim replaces the root: the checkpoint\'s nets, and the copies of the open round\'s felts hold', async () => {
    const { page: a } = await openedPage();
    const trim = trimOf(P, 'p');
    const copy = kit.slip(A, 4, [red(6)]);
    trimTo(a, P, trim, [copy]);
    const res = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res.base?.key).toBe(trim.key);
    expect(res.live).toBe(true);
    const want = foldOf([copy], trim.value);
    expect(want.open).toBe(4);
    expect(netOf(want, A)).toBe(25);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    expect(chips(a, B)).toBe(100 - 25);
    expect(a.casino.casinoWhole(T)).toBe(true);
    // and a page that hears it counts the same
    const b = await loadPage(2);
    sync(a, b);
    expect(chips(b, A)).toBe(100 + 25 - 6);
    expect(chips(b, B)).toBe(100 - 25);
  });

  it('a craps game counts the same way: its root, then a checkpoint with a carry', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(A.pid, 100);
    a.casino.buyInChips(B.pid, 100);
    const rootQ = rootOf(Q, 'q');
    put(a, rootQ);
    expect(a.casino.computedResolutionOf(T, Q.inc)).toMatchObject({ letter: 'q', live: true, holder: owner.pub });
    expect(chips(a, A)).toBe(100);
    const trimQ = trimOf(Q, 'q');
    trimTo(a, Q, trimQ);
    expect(a.casino.computedResolutionOf(T, Q.inc)!.base?.key).toBe(trimQ.key);
    expect(chips(a, A)).toBe(125);
    expect(chips(a, B)).toBe(75);
  });

  it('a game that has ended counts its nets and holds nothing', async () => {
    const { page: a } = await openedPage();
    const copy = kit.slip(A, 4, [red(6)]);
    const trim = trimOf(P, 'p');
    trimTo(a, P, trim, [copy]);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    const fin = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { u: 5, l: hex('e', 32), e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: { alice: '40', bob: '-40' } });
    trimTo(a, P, end, [copy]);
    const res = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res).toMatchObject({ live: false, invalid: [] });
    expect(res.base?.key).toBe(end.key);
    expect(res.fin).toEqual(fin);
    expect(chips(a, A)).toBe(140);
    expect(chips(a, B)).toBe(60);
  });

  it('a removal\'s gone: mark and the table\'s switch have no part in it: the game is live by its base alone', async () => {
    const { page: a, r1 } = await openedPage();
    const a2 = kit.slip(A, 2, [red(7)]);
    putSession(a, P, SID, a2);
    const net = foldOf(r1.all);
    expect(chips(a, A)).toBe(100 + netOf(net, A) - 7);
    a.doc.transact(() => {
      a.doc.getMap('casino').set(`gone:${T}:${P.inc}`, 1);
      a.doc.getMap('casino').set(`cfg:computed:${T}`, { v: 1, inc: `r${'0'.repeat(24)}` });
    });
    expect(a.casino.computedResolutionOf(T, P.inc)!.live).toBe(true);
    expect(chips(a, A)).toBe(100 + netOf(net, A) - 7);
    // (a table removed from the room marks no FAIR ONLY game either)
    a.casino.clearTableKeys(T);
    expect(a.doc.getMap('casino').has(`gone:${T}:${P.inc}`)).toBe(true); // (the one written above)
    a.doc.getMap('casino').delete(`gone:${T}:${P.inc}`);
    a.casino.clearTableKeys(T);
    expect(a.doc.getMap('casino').has(`gone:${T}:${P.inc}`)).toBe(false);
    expect(chips(a, A)).toBe(100 + netOf(net, A) - 7);
  });

  it('two games at one table are counted each by its own records: the ledger takes the nets of both, and one ending leaves the other', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    put(page, root, root2);
    const one = round1();
    const two = roundOne(kit2, SID2);
    const open2 = kit2.slip(A, 2, [red(7)]); // (the second game has a round open: its felt holds chips)
    putSession(page, P, SID, ...one.all);
    putSession(page, P2, SID2, ...two.all, open2);
    const netOne = foldOf(one.all);
    const netTwo = foldOf([...two.all, open2], root2.value, P2);
    expect(netOf(netOne, A)).not.toBe(0);
    expect(heldOf(netTwo, A)).toBe(7);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
    expect(page.casino.computedResolutionOf(T, P2.inc)).toMatchObject({ live: true });
    expect(chips(page, A)).toBe(100 + netOf(netOne, A) + netOf(netTwo, A) - 7);
    expect(chips(page, B)).toBe(100 + netOf(netOne, B) + netOf(netTwo, B));
    // the first game ends: its nets stand, and the second goes on alone, its felt still holding
    const fin = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { u: 5, l: hex('e', 32), e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: { alice: '40', bob: '-40' } });
    trimTo(page, P, end);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    expect(page.casino.computedResolutionOf(T, P2.inc)).toMatchObject({ live: true });
    expect(chips(page, A)).toBe(100 + 40 + netOf(netTwo, A) - 7);
    expect(chips(page, B)).toBe(100 - 40 + netOf(netTwo, B));
  });
});

// ── What starts a page tracking a game ───────────────────────────────────────

describe('what a page takes for a FAIR ONLY game, and what is junk to it', () => {
  const alone = async (...recs: { key: string; value: unknown }[]) => {
    const page = await loadPage(1);
    put(page, ...recs);
    return page;
  };

  it('a record of the game starts it: a session, a checkpoint, a transfer, an end order, even a junk value under a checkpoint\'s key', async () => {
    const tracked = (page: Page) => page.casino.computedResolutionOf(T, P.inc);
    const ses = await loadPage(1);
    ses.doc.transact(() => casinoComputed(ses).set(sesKey(P, SID), new Y.Map()));
    expect(tracked(ses)).toMatchObject({ base: null, live: false, chain: [] });
    expect(tracked(await alone(root))).toMatchObject({ live: true });
    expect(tracked(await alone(xferOf(P, owner, buyer, 1)))).toMatchObject({ base: null, live: false });
    const fin = sealFin(P, owner.pub, owner.sign);
    expect(tracked(await alone(fin))).toMatchObject({ base: null, live: false, fin: null });
    // (an end order beside a base is the game's: it counts when its signer holds the game there)
    expect(tracked(await alone(root, fin))).toMatchObject({ live: true, fin: fin.value });
    expect(tracked(await alone({ key: ckKey(T, P.inc, hex('1', 32)), value: { junk: 1 } }))).toMatchObject({ base: null, live: false });
    // (a name that is another game's, or a deed offer, starts nothing of this one)
    expect(await alone({ key: `do:${hex('a', 24)}`, value: { v: 1 } }).then(tracked)).toBeNull();
    expect(await alone({ key: ckKey(T, Q.inc, hex('1', 32)), value: { junk: 1 } }).then(tracked)).toBeNull();
  });

  it('a record put and deleted in one transaction starts no game', async () => {
    const page = await loadPage(1);
    page.doc.transact(() => {
      casinoComputed(page).set(root.key, root.value);
      casinoComputed(page).delete(root.key);
    });
    expect(page.casino.computedResolutionOf(T, P.inc)).toBeNull();
  });

  it('a first session (g), a page-signed summary (sum:) or an owner-signed one (hs:) of a FAIR ONLY name is junk: nothing starts', async () => {
    const page = await loadPage(1);
    page.doc.transact(() => {
      const map = casinoComputed(page);
      map.set(`ses:${T}:${P.inc}:g`, new Y.Map());
      map.set(`sum:${T}:${P.inc}`, { v: 1, b: 'g', u: 0, l: '0'.repeat(32), n: {}, k: owner.pub, g: 'x' });
      map.set(`hs:${T}:${P.inc}`, { v: 1 });
    });
    expect(page.casino.computedResolutionOf(T, P.inc)).toBeNull();
    // the same records at a name of the page-signed kind are what they always were
    const ordinary = `r${'0123456789abcdef01234567'}`;
    page.doc.transact(() => casinoComputed(page).set(`ses:${T}:${ordinary}:g`, new Y.Map()));
    expect(page.casino.computedResolutionOf(T, ordinary)).toBeNull(); // (tracked, but not a FAIR ONLY game)
    expect(page.casino.computedSwitchBare(T)).toBe(false);
  });

  it('a session named g beside a game with no base is nothing to it: not read, not weighed', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    putSession(page, P, 'g', ...round1().all);
    put(page, { key: ckKey(T, P.inc, hex('1', 32)), value: { junk: 1 } }); // (starts the game, which has no base)
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false });
    expect(page.casino.computedRoomBytes()).toBe(0);
    expect(chips(page, A)).toBe(100);
  });

  it('the table\'s switch cannot name a FAIR ONLY game yet: nothing plays one', async () => {
    const { page: a } = await openedPage();
    expect(a.casino.computedCfgInc({ v: 1, inc: P.inc })).toBeNull();
    a.doc.getMap('casino').set(`cfg:computed:${T}`, { v: 1, inc: P.inc });
    expect(a.casino.computedIncOf(T)).toBeNull();
    expect(a.casino.isComputedTable(T)).toBe(false);
    expect(a.casino.computedFoldOf(T)).toBeNull();
    // (it is counted all the same: the ledger and the felts go by the game)
    expect(a.casino.computedResolutionOf(T, P.inc)!.live).toBe(true);
    expect(chips(a, A)).not.toBe(100);
  });

  it('junk written, changed or deleted under a game\'s record keys, or under an hk: key, moves nothing: the game is not resolved again', async () => {
    const { page: a } = await openedPage();
    const res = () => a.casino.computedResolutionOf(T, P.inc)!;
    const before = res();
    const now = chips(a, A);
    const junk = [
      { key: ckKey(T, P.inc, hex('1', 32)), value: { junk: 1 } },
      { key: xfKey(T, P.inc, hex('2', 32)), value: { junk: 1 } },
      { key: finKey(T, P.inc), value: 'junk' },
      { key: delegationKey(house2.pub), value: { junk: 1 } },
      // (the root's own value, already read at its key, under a key that is not its id: the read is remembered by value and key)
      { key: ckKey(T, P.inc, hex('4', 32)), value: root.value },
    ];
    for (const j of junk) {
      put(a, j);
      expect(res()).toBe(before); // (the very object: it was not made again)
      put(a, { key: j.key, value: { junk: 2 } });
      expect(res()).toBe(before);
      a.doc.transact(() => casinoComputed(a).delete(j.key));
      expect(res()).toBe(before);
    }
    // a transfer that is well formed but sits under a key that is not its id is junk too, and so is a delegation under another house's key
    put(a, { key: xfKey(T, P.inc, hex('3', 32)), value: xferOf(P, owner, buyer, 1).value });
    put(a, { key: delegationKey(house.pub), value: delegation(owner, house2.pub) });
    expect(res()).toBe(before);
    expect(chips(a, A)).toBe(now);
  });

  it('what is something to the resolver moves the game, written or deleted: a transfer, an end order', async () => {
    const { page: a } = await openedPage();
    const res = () => a.casino.computedResolutionOf(T, P.inc)!;
    const first = res();
    const xf = xferOf(P, owner, buyer, 1);
    put(a, xf);
    expect(res()).not.toBe(first);
    expect(res().holder).toBe(buyer.pub);
    a.doc.transact(() => casinoComputed(a).delete(xf.key));
    expect(res().holder).toBe(owner.pub);
    const fin = sealFin(P, owner.pub, owner.sign);
    put(a, fin);
    expect(res().fin).toEqual(fin.value);
    a.doc.transact(() => casinoComputed(a).delete(fin.key));
    expect(res().fin).toBeNull();
    // junk over a good record is a record gone
    put(a, xf);
    expect(res().holder).toBe(buyer.pub);
    put(a, { key: xf.key, value: { junk: 1 } });
    expect(res().holder).toBe(owner.pub);
  });
});

// ── Which checkpoint is the base ─────────────────────────────────────────────

describe('the base a page counts from', () => {
  it('a checkpoint whose signature fails counts for nothing, is reported and is left where it is', async () => {
    const { page: a } = await openedPage();
    const trim = trimOf(P, 'p');
    const forged = changed(P, trim, { n: { alice: '99', bob: '-99' } });
    const before = chips(a, A);
    put(a, forged);
    const res = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res.base?.key).toBe(root.key);
    expect(res.invalid).toEqual([forged.key]);
    expect(chips(a, A)).toBe(before);
    expect(casinoComputed(a).has(forged.key)).toBe(true); // (a page writes nothing here: the duties of PR 6c-4b delete it)
    // and the honest one beside it is the base
    put(a, trim);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    // the forged one deleted from the doc is not reported any more
    a.doc.transact(() => casinoComputed(a).delete(forged.key));
    expect(a.casino.computedResolutionOf(T, P.inc)!.invalid).toEqual([]);
  });

  it('one signed by a key that could not hold the game is no base, and is not reported', async () => {
    const { page: a } = await openedPage();
    const before = chips(a, A);
    const theirs = trimOf(P, 'p', { k: stranger.pub, dl: delegation(stranger, stranger.pub) });
    put(a, theirs);
    const res = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res.base?.key).toBe(root.key);
    expect(res.invalid).toEqual([]);
    expect(chips(a, A)).toBe(before);
  });

  it('a game of a rules version this build does not know counts nothing, whatever its session holds', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    const ctx = ctxOf('p', T, { ...NAME, rv: 'f9' });
    const newer = rootOf(ctx, 'p', { rv: 'f9' });
    put(page, newer);
    const k = new ComputedKit(ctx);
    const slip = k.slip(A, 1, [red(5)]);
    putSession(page, ctx, nextSid3(ctx, newer.value), slip);
    expect(page.casino.computedResolutionOf(T, ctx.inc)).toMatchObject({ newer: true, base: null, live: false });
    expect(chips(page, A)).toBe(100);
  });

  it('a checkpoint of a rules version this build does not know is not junk: it moves a game that was resolved without it', async () => {
    const page = await loadPage(1);
    const ctx = ctxOf('p', T, { ...NAME, rv: 'f9' });
    put(page, { key: ckKey(T, ctx.inc, hex('1', 32)), value: { junk: 1 } });
    expect(page.casino.computedResolutionOf(T, ctx.inc)).toMatchObject({ newer: false, base: null });
    put(page, rootOf(ctx, 'p', { rv: 'f9' }));
    expect(page.casino.computedResolutionOf(T, ctx.inc)).toMatchObject({ newer: true, base: null });
  });

  it('with no checkpoint the game is not open: its session is weighed and counts nothing, until one comes', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    const r1 = round1();
    putSession(page, P, SID, ...r1.all, kit.slip(A, 2, [red(7)]));
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false });
    expect(chips(page, A)).toBe(100);
    expect(chips(page, B)).toBe(100);
    expect(page.casino.computedSettled()).toBe(true);
    put(page, root);
    expect(chips(page, A)).toBe(100 + netOf(foldOf(r1.all), A) - 7);
  });

  it('goes on from the checkpoint it counted when the doc loses it, and an older one put back does not take the table back', async () => {
    const { page: a } = await openedPage();
    const trim = trimOf(P, 'p');
    const copy = kit.slip(A, 4, [red(6)]);
    trimTo(a, P, trim, [copy]);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    // a peer deletes it: the root is all the doc holds, and the table goes on from the trim
    a.doc.transact(() => casinoComputed(a).delete(trim.key));
    expect(casinoComputed(a).has(trim.key)).toBe(false);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    expect(a.casino.casinoWhole(T)).toBe(true);
    // the root deleted and put back changes nothing either
    a.doc.transact(() => casinoComputed(a).delete(root.key));
    put(a, root);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    // and junk written over its key (the key is its hash, so nothing honest has it) leaves the table where it is
    put(a, { key: trim.key, value: { junk: 1 } });
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    // (junk resolves nothing again: a record that is something does, and the page still offers the resolver the checkpoint it held, not the junk at its key)
    const resolved = a.casino.computedResolutionOf(T, P.inc);
    put(a, sealFin(P, owner.pub, owner.sign));
    expect(a.casino.computedResolutionOf(T, P.inc)).not.toBe(resolved);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    // a page that never counted the trim has only the root to go by: that page counts the root's session, which is gone
    const b = await loadPage(2);
    const copyDoc = new Y.Doc();
    Y.applyUpdate(copyDoc, Y.encodeStateAsUpdate(a.doc));
    b.casino.bindCasinoDoc(copyDoc, ROOM);
    expect(b.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(root.key);
    expect(b.casino.readChips(A.pid)).toBe(100);
  });

  it('keeps what it counted while a transfer puts it out of range, and goes on from it when the transfer is gone', async () => {
    const { page: a } = await openedPage();
    const trim = trimOf(P, 'p'); // round 3, the owner's house
    trimTo(a, P, trim, [kit.slip(A, 4, [red(6)])]);
    a.doc.transact(() => {
      casinoComputed(a).delete(trim.key);
      casinoComputed(a).delete(root.key);
    });
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    // the owner sold the game at round 1: the trim is out of their range, and the doc holds nothing else to go by
    const xf = xferOf(P, owner, buyer, 1);
    put(a, xf);
    expect(a.casino.computedResolutionOf(T, P.inc)).toMatchObject({ holder: buyer.pub, base: null, live: false });
    expect(chips(a, A)).toBe(100);
    // the transfer gone: the game is the owner's again, and the page still has the trim
    a.doc.transact(() => casinoComputed(a).delete(xf.key));
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
  });

  it('a higher checkpoint takes over from the one it held, and is the one it holds then', async () => {
    const { page: a } = await openedPage();
    const first = trimOf(P, 'p');
    trimTo(a, P, first);
    const second = trimOf(P, 'p', { u: 6, l: hex('e', 32), n: { alice: '50', bob: '-50' } });
    trimTo(a, P, second);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(second.key);
    expect(chips(a, A)).toBe(150);
    // both gone from the doc: the second is the one it goes on from
    a.doc.transact(() => {
      casinoComputed(a).delete(first.key);
      casinoComputed(a).delete(second.key);
    });
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(second.key);
    expect(chips(a, A)).toBe(150);
  });

  it('a transfer that puts the checkpoint it counted out of its authority\'s range takes the page to the base the new chain allows, and the buyer\'s adoption brings it back', async () => {
    const { page: a } = await openedPage();
    const trim = trimOf(P, 'p'); // round 3, the owner's house
    const copy = kit.slip(A, 4, [red(6)]);
    trimTo(a, P, trim, [copy]);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    // the owner sold the game at round 1: the trim (round 3, theirs) is out of their range
    const xf = xferOf(P, owner, buyer, 1);
    put(a, xf);
    let res = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res.holder).toBe(buyer.pub);
    expect(res.base?.key).toBe(root.key);
    expect(chips(a, A)).toBe(100);
    expect(chips(a, B)).toBe(100);
    expect(a.casino.casinoWhole(T)).toBe(true);
    // the buyer's checkpoint of the same state carries the transfer, and is the base: the same session
    const adoption = trimOf(P, 'p', { k: buyer.pub, dl: undefined, x: [xf.value] });
    expect(nextSid3(P, adoption.value)).toBe(nextSid3(P, trim.value));
    put(a, adoption);
    res = a.casino.computedResolutionOf(T, P.inc)!;
    expect(res.base?.key).toBe(adoption.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
    expect(chips(a, B)).toBe(100 - 25);
    // the seller's later checkpoint is not the game's
    const later = trimOf(P, 'p', { u: 6, l: hex('e', 32), n: { alice: '90', bob: '-90' } });
    put(a, later);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(adoption.key);
    expect(chips(a, A)).toBe(100 + 25 - 6);
  });
});

// ── Whatever order the records come in ───────────────────────────────────────

describe('the same records, whichever way they come', () => {
  /** Each order writes the same game into a fresh page: the root, the trim and round 1's records. */
  const orders: Record<string, (page: Page, r1: ReturnType<typeof round1>, trim: ReturnType<typeof trimOf>) => void> = {
    'the root, then the session record by record': (page, r1) => {
      put(page, root);
      for (const r of r1.all) putSession(page, P, SID, r);
    },
    'the session record by record, then the root': (page, r1) => {
      for (const r of r1.all) putSession(page, P, SID, r);
      put(page, root);
    },
    'the session whole, then the root': (page, r1) => {
      putSession(page, P, SID, ...r1.all);
      put(page, root);
    },
    'all in one transaction': (page, r1) => {
      page.doc.transact(() => {
        put(page, root);
        putSession(page, P, SID, ...r1.all);
      });
    },
    'the round\'s end first (a reveal, then what it decides)': (page, r1) => {
      put(page, root);
      putSession(page, P, SID, r1.hr, r1.rb, r1.ra, r1.close, r1.join, r1.b1, r1.a1);
    },
  };

  it('count the same nets and hold the same chips', async () => {
    const r1 = round1();
    const want = foldOf(r1.all);
    const extra = kit.slip(A, 2, [red(7)]);
    for (const [name, order] of Object.entries(orders)) {
      const page = await loadPage(1);
      page.casino.buyInChips(A.pid, 100);
      page.casino.buyInChips(B.pid, 100);
      pin(page, A, B);
      order(page, r1, trimOf(P, 'p'));
      putSession(page, P, SID, extra);
      expect(chips(page, A), name).toBe(100 + netOf(want, A) - 7);
      expect(chips(page, B), name).toBe(100 + netOf(want, B));
      expect(page.casino.computedSettled(), name).toBe(true);
    }
  });

  it('a trim before its session, a session before its trim, and a trim whose session came first, end at the same base', async () => {
    const trim = trimOf(P, 'p');
    const copy = kit.slip(A, 4, [red(6)]);
    const ses = nextSid3(P, trim.value);
    const ways: Record<string, (page: Page) => void> = {
      'the trim, then its session': (page) => {
        put(page, root, trim);
        putSession(page, P, ses, copy);
      },
      'its session, then the trim': (page) => {
        put(page, root);
        putSession(page, P, ses, copy);
        put(page, trim);
      },
      'the trim in one transaction with its session': (page) => {
        put(page, root);
        trimTo(page, P, trim, [copy]);
      },
    };
    for (const [name, way] of Object.entries(ways)) {
      const page = await loadPage(1);
      page.casino.buyInChips(A.pid, 100);
      page.casino.buyInChips(B.pid, 100);
      pin(page, A, B);
      way(page);
      expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key, name).toBe(trim.key);
      expect(chips(page, A), name).toBe(100 + 25 - 6);
      expect(chips(page, B), name).toBe(100 - 25);
    }
  });
});

// ── Signatures that wait ─────────────────────────────────────────────────────

describe('a check that has not been made yet', () => {
  it('leaves the game pending and counts nothing, and a slice makes the check and counts', async () => {
    const page = await loadPage(1, { now: () => 0, budgetMs: 0 });
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    const r1 = round1();
    put(page, root);
    putSession(page, P, SID, ...r1.all);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false, pending: true });
    expect(page.casino.computedSettled()).toBe(false);
    expect(page.casino.computedSettled(T)).toBe(false);
    expect(chips(page, A)).toBe(100);
    // the budget back: the slice resolves the game, then the fold checks what it counts
    page.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, pending: false });
    expect(page.casino.computedSettled()).toBe(true);
    expect(chips(page, A)).toBe(100 + netOf(foldOf(r1.all), A));
  });

  it('a better checkpoint put off leaves the game on the one it can check, pending until it is', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    put(page, root);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, pending: false });
    // no time to check the trim when it comes: it waits, and the game stays on the root it has checked
    page.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const trim = trimOf(P, 'p');
    trimTo(page, P, trim);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: true });
    expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(root.key);
    expect(page.casino.computedSettled()).toBe(false);
    page.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: false });
    expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(page, A)).toBe(125);
    expect(page.casino.computedSettled()).toBe(true);
  });

  it('each signature is checked once, however many records come after it', async () => {
    const calls: string[] = [];
    const page = await loadPage(1, { now: () => 0, verify: (_pub, _bytes, sig) => { calls.push(sig); return true; } });
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    put(page, root);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    expect(new Set(calls).size).toBe(first);
    // more records of the game, of the room and of the session: nothing is asked again
    const r1 = round1();
    for (const r of r1.all) putSession(page, P, SID, r);
    put(page, xferOf(P, owner, buyer, 1)); // (junk would resolve nothing again: a transfer does)
    page.doc.transact(() => page.doc.getMap('casino').set('unrelated', 1));
    const rootAsked = calls.slice(0, first);
    for (const sig of rootAsked) expect(calls.slice(first).filter((s) => s === sig), 'the root\'s signatures').toEqual([]);
  });

  it('spends a recount\'s budget across a game\'s signatures, and the slices after it check the rest', async () => {
    let spend = 0;
    // each check costs 50 ms of a 40 ms budget: one a recount
    const page = await loadPage(1, { now: () => (spend += 50), budgetMs: 40 });
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    put(page, root); // its own signature, then the delegation it carries
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false, pending: true });
    expect(page.casino.computedSettled()).toBe(false);
    await flush();
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, pending: false });
    expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(root.key);
    expect(page.casino.computedSettled()).toBe(true);
  });

  it('keeps the latest verdicts only: with room for fewer than a record\'s signatures it asks again, with the room it was built with it does not', async () => {
    const asked = new Map<string, number>();
    const verify = (_pub: string, _bytes: Uint8Array, sig: string): boolean => {
      asked.set(sig, (asked.get(sig) ?? 0) + 1);
      return true;
    };
    const fin = sealFin(P, owner.pub, owner.sign).value;
    // an end order carries its own signature, the delegation and the order's: three to check
    const end = trimOf(P, 'p', { u: 5, l: hex('e', 32), e: 1, f: fin, s: undefined, h: undefined, n: { alice: '40', bob: '-40' } });
    const times: Record<string, number> = {};
    for (const authMax of [undefined, 2]) {
      asked.clear();
      const page = await loadPage(1, { now: () => 0, verify, authMax });
      put(page, root);
      put(page, end);
      expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(end.key);
      // another record of the game (an end order beside the end checkpoint: junk would resolve nothing): it is resolved again
      put(page, sealFin(P, owner.pub, owner.sign));
      expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(end.key);
      times[String(authMax)] = asked.get(DL_HOUSE.g) ?? 0;
    }
    expect(times).toEqual({ undefined: 1, 2: 2 });
  });

  it('keeps a refusal as it keeps a yes: a signature that failed is not checked again', async () => {
    const asked = new Map<string, number>();
    const page = await loadPage(1, {
      now: () => 0,
      verify: (_pub, _bytes, sig) => {
        asked.set(sig, (asked.get(sig) ?? 0) + 1);
        return sig !== DL_HOUSE.g;
      },
    });
    put(page, root);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false });
    expect(page.casino.computedResolutionOf(T, P.inc)!.invalid).toEqual([root.key]);
    const before = page.casino.computedResolutionOf(T, P.inc);
    put(page, { key: ckKey(T, P.inc, hex('1', 32)), value: { junk: 1 } });
    expect(page.casino.computedResolutionOf(T, P.inc)).toBe(before); // (junk: the game is not resolved again)
    put(page, xferOf(P, owner, buyer, 1)); // (a transfer is: it is resolved again, and the refusal comes from the cache)
    expect(page.casino.computedResolutionOf(T, P.inc)).not.toBe(before);
    expect(page.casino.computedResolutionOf(T, P.inc)!.invalid).toEqual([root.key]);
    expect(asked.get(DL_HOUSE.g)).toBe(1);
  });

  it('takes a check that throws for a refusal, not a crash', async () => {
    const page = await loadPage(1, { now: () => 0, verify: () => { throw new Error('not a key'); } });
    put(page, root);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false, pending: false });
    expect(page.casino.computedResolutionOf(T, P.inc)!.invalid).toEqual([root.key]);
  });

  it('takes a check that says anything but yes for a refusal', async () => {
    const page = await loadPage(1, { now: () => 0, verify: () => 1 as unknown as boolean });
    put(page, root);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false, pending: false });
    expect(page.casino.computedResolutionOf(T, P.inc)!.invalid).toEqual([root.key]);
  });

  it('a slice resolves again the games that waited, and no other', async () => {
    const page = await loadPage(1);
    put(page, root);
    put(page, rootOf(Q, 'q'));
    const settled = page.casino.computedResolutionOf(T, Q.inc)!;
    expect(settled).toMatchObject({ live: true, pending: false });
    page.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    trimTo(page, P, trimOf(P, 'p'));
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: true });
    page.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: false });
    expect(page.casino.computedResolutionOf(T, Q.inc)).toBe(settled);
  });

  it('does not carry a verdict to another room: a delegation checked in one room is checked again in the next', async () => {
    const a = await loadPage(1);
    put(a, root); // (its root carries a delegation signed for ROOM)
    expect(a.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
    // another room's doc, with a game of its own (a game's name binds its room) whose root carries that same delegation
    const ctxB: FoldCtx = { room: 'room-b', t: T, inc: faironlyInc('p', 'room-b', T, NAME) };
    const rootB = rootOf(ctxB, 'p');
    const other = new Y.Doc();
    other.getMap<unknown>('casinoComputed').set(rootB.key, rootB.value);
    a.casino.bindCasinoDoc(other, 'room-b');
    expect(a.casino.computedResolutionOf(T, ctxB.inc)).toMatchObject({ base: null, live: false });
    expect(a.casino.computedResolutionOf(T, ctxB.inc)!.invalid).toEqual([rootB.key]);
  });
});

// ── WebCrypto ────────────────────────────────────────────────────────────────

describe('a game\'s checks past a recount\'s budget go to WebCrypto, as every other record\'s do', () => {
  /** A clock that moves 0.5 ms a read, a noble check and a send each reading it twice; a budget
   *  of one noble check a recount. */
  const clock = () => {
    let reads = 0;
    return { now: () => (reads += 1) * 0.5, budgetMs: 0.5, reads: () => reads };
  };

  it('counts the same base: the first check on noble, the next on WebCrypto, a check in flight not made again', async () => {
    const c = clock();
    const page = await loadPage(1, c, true);
    const calls = countWebCrypto();
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    put(page, root);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, pending: true });
    expect(c.reads()).toBe(4); // its signature on noble, the delegation's sent
    // the room meanwhile delegates a house (junk would resolve nothing again; this does): the root's delegation is in flight, and is checked neither again nor on noble
    const before = page.casino.computedResolutionOf(T, P.inc);
    put(page, { key: delegationKey(house2.pub), value: delegation(owner, house2.pub) });
    expect(page.casino.computedResolutionOf(T, P.inc)).not.toBe(before);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: true });
    expect(c.reads()).toBe(4);
    expect(await until(() => page.casino.computedSettled())).toBe(true);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, pending: false });
    expect(page.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(root.key);
    expect(calls.verifies).toBe(1);
    expect(c.reads()).toBe(4);
  });

  it('refuses past the budget what the byte checks refuse, as noble does, without asking WebCrypto', async () => {
    const c = clock();
    const page = await loadPage(1, c, true);
    const calls = countWebCrypto();
    // a delegation whose signature has a stray bit: noble refuses it, and so do the byte checks
    const bad = rootOf(P, 'p', { dl: { ...DL_HOUSE, g: strayBit(DL_HOUSE.g) } });
    put(page, bad);
    const res = page.casino.computedResolutionOf(T, P.inc)!;
    expect(res).toMatchObject({ base: null, live: false, pending: false });
    expect(res.invalid).toContain(bad.key);
    expect(calls.imports + calls.verifies).toBe(0);
    expect(c.reads()).toBe(4);
    expect(page.casino.computedSettled()).toBe(true);
  });

  it('refuses past the budget what WebCrypto says no to and noble refuses after', async () => {
    const c = clock();
    const page = await loadPage(1, c, true);
    const calls = countWebCrypto();
    // a real signature of something else: well-formed, and wrong
    const bad = rootOf(P, 'p', { dl: { ...DL_HOUSE, g: owner.sign(new TextEncoder().encode('another message')) } });
    put(page, bad);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, pending: true });
    expect(await until(() => page.casino.computedResolutionOf(T, P.inc)!.pending === false)).toBe(true);
    const res = page.casino.computedResolutionOf(T, P.inc)!;
    expect(res).toMatchObject({ base: null, live: false });
    expect(res.invalid).toContain(bad.key);
    expect(calls.verifies).toBe(1);
    expect(c.reads()).toBe(6); // (its own and the delegation\'s on WebCrypto then noble)
  });
});

// ── Houses ───────────────────────────────────────────────────────────────────

describe('which houses decide a round', () => {
  /** Round 1 decided by `h`, who is joined and reveals. */
  function houseRound(h: TestHouse) {
    const a1 = kit.slip(A, 1, [red(10)]);
    const b1 = kit.slip(B, 1, [black(5)]);
    const join = kit.houseJoin(h, 1);
    const close = kit.close(A, 1, SID, [a1, b1], join.rec.c);
    const ra = kit.reveal(1, A.pid);
    const rb = kit.reveal(1, B.pid);
    const hr = kit.houseReveal(h, 1, [close.hash], [a1.hash, b1.hash]);
    return [a1, b1, join, close, ra, rb, hr] as Built<unknown>[];
  }

  it('the house of the root\'s delegation decides, and another house does not until the holder delegates it in the room', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    put(page, root);
    const second = houseRound(house2);
    putSession(page, P, SID, ...second);
    // no house of the root's delegation reveals: the round is undecided, its stakes held
    const open = foldOf(second, root.value, P, cachingCheck().check, housesAre());
    expect(open.rounds).toEqual([]);
    expect(open.open).toBe(1);
    expect(heldOf(open, A)).toBe(10);
    expect(heldOf(open, B)).toBe(5);
    expect(chips(page, A)).toBe(100 - 10);
    expect(chips(page, B)).toBe(100 - 5);
    // the owner delegates the second house in the room: the round is decided, with no record of the session written
    put(page, { key: delegationKey(house2.pub), value: delegation(owner, house2.pub) });
    const decided = foldOf(second, root.value, P, cachingCheck().check, housesAre(house2));
    expect(decided.rounds.map((v) => v.decided)).toEqual(['house']);
    expect(chips(page, A)).toBe(100 + netOf(decided, A));
    expect(chips(page, B)).toBe(100 + netOf(decided, B));
    expect(netOf(decided, A)).not.toBe(0);
    // and deleted again, it decides no more
    page.doc.transact(() => casinoComputed(page).delete(delegationKey(house2.pub)));
    expect(chips(page, A)).toBe(100 - 10);
    expect(chips(page, B)).toBe(100 - 5);
  });

  it('on a page bound to a doc that holds the delegation already, the round it decides counts', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(A.pid, 100);
    a.casino.buyInChips(B.pid, 100);
    pin(a, A, B);
    put(a, root);
    const second = houseRound(house2);
    putSession(a, P, SID, ...second);
    put(a, { key: delegationKey(house2.pub), value: delegation(owner, house2.pub) });
    const decided = foldOf(second, root.value, P, cachingCheck().check, housesAre(house2));
    expect(decided.rounds.map((v) => v.decided)).toEqual(['house']);
    const late = await loadPage(3);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.doc));
    late.casino.bindCasinoDoc(copy, ROOM);
    expect(chips(late, A)).toBe(100 + netOf(decided, A));
    expect(chips(late, B)).toBe(100 + netOf(decided, B));
  });

  it('on a page bound to a doc whose delegation sits under another house\'s key, or is junk, no house is made of it', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(A.pid, 100);
    a.casino.buyInChips(B.pid, 100);
    pin(a, A, B);
    put(a, root);
    putSession(a, P, SID, ...houseRound(house2));
    put(a, { key: delegationKey(house.pub), value: delegation(owner, house2.pub) });
    put(a, { key: delegationKey(house2.pub), value: { junk: 1 } });
    const late = await loadPage(3);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.doc));
    late.casino.bindCasinoDoc(copy, ROOM);
    expect(chips(late, A)).toBe(100 - 10);
    expect(chips(late, B)).toBe(100 - 5);
  });

  it('a page bound again to a doc without the delegation has no house of it any more', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(A.pid, 100);
    a.casino.buyInChips(B.pid, 100);
    pin(a, A, B);
    put(a, root);
    const second = houseRound(house2);
    putSession(a, P, SID, ...second);
    const decided = foldOf(second, root.value, P, cachingCheck().check, housesAre(house2));
    put(a, { key: delegationKey(house2.pub), value: delegation(owner, house2.pub) });
    expect(chips(a, A)).toBe(100 + netOf(decided, A));
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.doc));
    copy.getMap<unknown>('casinoComputed').delete(delegationKey(house2.pub));
    a.casino.bindCasinoDoc(copy, ROOM);
    expect(chips(a, A)).toBe(100 - 10);
    expect(chips(a, B)).toBe(100 - 5);
  });

  it('a delegation overwritten by junk takes its house away, and put back brings it', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    put(page, root);
    const second = houseRound(house2);
    putSession(page, P, SID, ...second);
    const decided = foldOf(second, root.value, P, cachingCheck().check, housesAre(house2));
    const dl = { key: delegationKey(house2.pub), value: delegation(owner, house2.pub) };
    put(page, dl);
    expect(chips(page, A)).toBe(100 + netOf(decided, A));
    put(page, { key: dl.key, value: { junk: 1 } });
    expect(chips(page, A)).toBe(100 - 10);
    put(page, dl);
    expect(chips(page, A)).toBe(100 + netOf(decided, A));
  });

  it('a delegation by a key that does not hold the game, or under another house\'s key, makes no house', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    put(page, root);
    putSession(page, P, SID, ...houseRound(house2));
    // the stranger\'s delegation of the house, and the owner\'s kept under the wrong key
    put(page, { key: delegationKey(house2.pub), value: delegation(stranger, house2.pub) });
    put(page, { key: delegationKey(house.pub), value: delegation(owner, house2.pub) });
    expect(chips(page, A)).toBe(100 - 10);
    // (kept out of the resolver's feed, not merely unread: a delegation that is something, put after them, resolves the game again and finds them still no house)
    put(page, { key: delegationKey(third.pub), value: delegation(owner, third.pub) });
    expect(chips(page, A)).toBe(100 - 10);
  });

  it('a house counts only for the rounds its delegator held the game: a transfer takes the later rounds from it', async () => {
    const r1 = round1();
    const r2 = round2(r1);
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    page.casino.buyInChips(B.pid, 100);
    pin(page, A, B);
    put(page, root);
    putSession(page, P, SID, ...r1.all, ...r2.all);
    const both = foldOf([...r1.all, ...r2.all]);
    expect(both.rounds.map((v) => v.decided)).toEqual(['house', 'house']);
    expect(chips(page, A)).toBe(100 + netOf(both, A));
    // the owner sold the game at round 1: their house decided round 1, and round 2 is the buyer's to decide
    put(page, xferOf(P, owner, buyer, 1));
    const upTo1: HouseCheck = (pub, round) => pub === house.pub && round <= 1;
    const fold = new TableFold(P, cachingCheck().check, undefined, undefined, upTo1);
    fold.setFairOnlyBase(root.value);
    fold.reset([...r1.all, ...r2.all].map((b) => [b.key, b.rec] as const));
    const after = fold.result();
    expect(after.rounds.map((v) => [v.r, v.decided])).toEqual([[1, 'house'], [2, null]]);
    expect(page.casino.computedResolutionOf(T, P.inc)!.holder).toBe(buyer.pub);
    expect(chips(page, A)).toBe(100 + netOf(after, A) - heldOf(after, A));
    expect(chips(page, B)).toBe(100 + netOf(after, B) - heldOf(after, B));
    expect(netOf(after, A)).not.toBe(netOf(both, A));
  });
});

// ── What a page leaves to the game's own authority ───────────────────────────

describe('what a page does not do at a FAIR ONLY game', () => {
  it('writes nothing for one: the recovery, the switch and the finalising of a page-signed table refuse it', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    const end = kit.checkpoint(owner, 'g', 1, hex('1', 32), {}, 1);
    const before = Y.encodeStateAsUpdate(a.doc);
    expect(c.finalizeComputed(T, P.inc, end)).toBe(false);
    expect(c.finalizeComputed(T, P.inc, null)).toBe(false);
    expect(c.putComputedSwitchBack(T, P.inc)).toBe(false);
    expect(c.writeComputedGone(T, P.inc)).toBe(false);
    expect(c.reopenComputedSession(T, P.inc)).toBe(false);
    expect(c.giveUpComputed(T, P.inc)).toBe(false);
    expect(c.giveWayComputed(T, P.inc)).toBe(false);
    expect(c.restoreComputedCheckpoint(T, P.inc, root.value)).toBe(false);
    expect(c.computedRestorePending(T, P.inc)).toBe(false);
    // (the table's switch is not the game's to lose, nor to leave bare)
    expect(c.computedSwitchLost(T)).toBe(false);
    expect(c.computedSwitchLost(T, 'roulette')).toBe(false);
    expect(c.computedSwitchBare(T)).toBe(false);
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(before);
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
  });

  it('is in none of the lists the recovery and the compaction of page-signed tables go by', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    const lists = () => ({
      recoveries: c.computedRecoveries().filter((r) => r.t === T), pending: c.computedRecoveryPending(), ended: c.computedEndedIncs(), live: c.computedLiveTables(),
    });
    const none = { recoveries: [], pending: false, ended: [], live: [] };
    expect(lists()).toEqual(none);
    // its session gone: a page-signed table's recovery would open another, and this one is lost
    a.doc.transact(() => casinoComputed(a).delete(sesKey(P, SID)));
    expect(c.casinoWhole(T)).toBe(false);
    expect(lists()).toEqual(none);
    // and ended, with its last session still in the doc
    const copy = kit.slip(A, 4, [red(6)]);
    const end = trimOf(P, 'p', { u: 5, l: hex('e', 32), e: 1, f: sealFin(P, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: { alice: '40', bob: '-40' } });
    trimTo(a, P, end, [copy]);
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    expect(lists()).toEqual(none);
  });

  it('weighs in the room\'s computed bytes while it is open, as any table\'s session does', async () => {
    const page = await loadPage(1);
    put(page, root);
    expect(page.casino.computedRoomBytes()).toBe(0);
    const { page: a } = await openedPage();
    expect(a.casino.computedRoomBytes()).toBeGreaterThan(0);
  });
});

// ── A game whose session is gone ─────────────────────────────────────────────

describe('a FAIR ONLY game whose counted session is gone from the doc', () => {
  it('is lost with nothing in its place: the table is not whole, its last counts stand, and it counts again when the session comes back', async () => {
    const { page: a, r1 } = await openedPage();
    const net = foldOf(r1.all);
    expect(a.casino.casinoWhole(T)).toBe(true);
    a.doc.transact(() => casinoComputed(a).delete(sesKey(P, SID)));
    expect(a.casino.casinoWhole(T)).toBe(false);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(chips(a, A)).toBe(100 + netOf(net, A));
    expect(chips(a, B)).toBe(100 + netOf(net, B));
    // it waits for what will not come, and stops itself alone
    expect(a.casino.computedSettled(T)).toBe(false);
    expect(a.casino.computedSettled()).toBe(true);
    // the session back (one map of its own, the records put back): counted again
    putSession(a, P, SID, ...r1.all);
    expect(a.casino.casinoWhole(T)).toBe(true);
    expect(a.casino.computedSettled(T)).toBe(true);
    const a2 = kit.slip(A, 2, [red(7)]);
    putSession(a, P, SID, a2);
    expect(chips(a, A)).toBe(100 + netOf(net, A) - 7);
  });

  it('is not lost by a trim, which deletes its session and opens the next: the checkpoint is the base now', async () => {
    const { page: a } = await openedPage();
    expect(a.casino.casinoWhole(T)).toBe(true);
    const trim = trimOf(P, 'p');
    trimTo(a, P, trim);
    expect(a.casino.casinoWhole(T)).toBe(true);
    expect(a.casino.computedSettled(T)).toBe(true);
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(chips(a, A)).toBe(125);
    // the session it opened deleted in its turn: lost again, at its own sid
    a.doc.transact(() => casinoComputed(a).delete(sesKey(P, nextSid3(P, trim.value))));
    expect(a.casino.casinoWhole(T)).toBe(false);
    expect(chips(a, A)).toBe(125);
  });

  it('one whose session never came is not lost: it was never counted', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B);
    put(page, root);
    expect(page.casino.casinoWhole(T)).toBe(true);
    expect(page.casino.computedSettled(T)).toBe(true);
    expect(chips(page, A)).toBe(100);
  });

  it('one that has ended is not lost, whatever becomes of the session after its end: its nets stand from the end checkpoint', async () => {
    const { page: a } = await openedPage();
    const copy = kit.slip(A, 4, [red(6)]);
    const fin = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { u: 5, l: hex('e', 32), e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: { alice: '40', bob: '-40' } });
    trimTo(a, P, end, [copy]);
    expect(a.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    expect(a.casino.casinoWhole(T)).toBe(true);
    expect(chips(a, A)).toBe(140);
    // the session after the end gone, as a compaction would take it
    a.doc.transact(() => casinoComputed(a).delete(sesKey(P, nextSid3(P, end.value))));
    expect(a.casino.casinoWhole(T)).toBe(true);
    expect(a.casino.computedSettled(T)).toBe(true);
    expect(chips(a, A)).toBe(140);
    expect(chips(a, B)).toBe(60);
  });

  it('does not stop another table: only its own', async () => {
    const { page: a } = await openedPage();
    const ordinary = 'roulette-2';
    expect(a.casino.casinoWhole(ordinary)).toBe(true);
    a.doc.transact(() => casinoComputed(a).delete(sesKey(P, SID)));
    expect(a.casino.casinoWhole(T)).toBe(false);
    expect(a.casino.casinoWhole(ordinary)).toBe(true);
    expect(a.casino.casinoWhole()).toBe(true);
  });
});

// ── What listeners hear ──────────────────────────────────────────────────────

describe('what a page tells its listeners of a FAIR ONLY game', () => {
  it('the table\'s view and the players\' balances, once for a transaction that moves them, and nothing for one that moves nothing', async () => {
    const { page: a } = await openedPage();
    let view = 0;
    const bals: number[] = [];
    a.casino.subscribeCasinoKey(`computed:${T}`, () => { view += 1; });
    a.casino.subscribeCasinoKey(`bal:${A.pid}`, () => { bals.push(chips(a, A)); });
    const now = chips(a, A);
    const a2 = kit.slip(A, 2, [red(7)]);
    putSession(a, P, SID, a2);
    expect(view).toBe(1);
    expect(bals).toEqual([now - 7]);
    // nothing of the game moved
    a.doc.transact(() => a.doc.getMap('casino').set('unrelated', 1));
    putSession(a, P, SID, a2);
    expect(view).toBe(1);
    expect(bals).toEqual([now - 7]);
    // the game's base replaced: told again
    trimTo(a, P, trimOf(P, 'p'));
    expect(view).toBe(2);
    expect(bals).toEqual([now - 7, 125]);
  });
});
