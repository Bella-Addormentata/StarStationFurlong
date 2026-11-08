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
import { nextSid, nextSid3, TableFold } from './computedFold';
import type { FoldCtx, FoldResult, HouseCheck } from './computedFold';
import { delegationKey } from './computedHouse';
import { ckKey, faironlyInc, finKey, NO_CLOSE, sealCk, sealFin, sealXf, xfKey } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import {
  authEnv, buyer, changed, ctxOf, DL_HOUSE, delegation, fourth, hex, house, house2, NAME, owner, P, Q, rootOf, ROOM, stranger, T, third, trimOf, xferOf,
} from './computedFairOnlyKit';
import { black, cachingCheck, ComputedKit, housesAre, red, testIdentity } from './computedTestKit';
import type { Built, TestHouse, TestIdentity } from './computedTestKit';

void [authEnv, fourth, third, hex, delegation, xfKey, sealXf, finKey, sealFin, xferOf, buyer, stranger, house2, DL_HOUSE, changed, trimOf];

type Page = { casino: typeof import('./casinoDoc'); doc: Y.Doc };

vi.stubGlobal('window', { location: { search: '' } });

/** The times S9 (tableGame) was asked, over every load of the modules: a spec counts the looks a transaction makes. */
const asked = vi.hoisted(() => ({ tableGame: 0, games: -1 }));
vi.mock('./computedFairOnlyAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./computedFairOnlyAuth')>();
  return { ...real, tableGame: (...args: Parameters<typeof real.tableGame>) => { asked.tableGame += 1; asked.games = args[0].length; return real.tableGame(...args); } };
});

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

/** `value` padded with fields valued undefined, which the shape checks read as absent and a weight
 *  (weightOf) counts: 600 of them weigh some 10 KB, past MAX_SMALL_RECORD_BYTES (8 KB). */
const padded = <V extends object>(value: V): V => ({
  ...value,
  ...Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`pad${i}`, undefined])),
});

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

// ── Who opened it ────────────────────────────────────────────────────────────

describe('who a page takes to have opened a game: no one is checked yet (the trust root, design §2.2, owner question 13)', () => {
  /** The game a guest opens for itself: its name binds the guest's key, and its house is the guest's own. */
  const guestName = { ...NAME, ok: stranger.pub, j: hex('3', 16) };
  const G = ctxOf('p', T, guestName);
  const theirs = (n: Record<string, string>) => trimOf(G, 'p', { ok: stranger.pub, j: guestName.j, k: house2.pub, dl: delegation(stranger, house2.pub), n });

  it('a game a guest opened with its own key counts like any other, beside the owner\'s: the resolution says whose it is, and a page has no verified owner to admit an opener against until the ownership root', async () => {
    const page = await loadPage(1);
    page.casino.buyInChips(A.pid, 100);
    pin(page, A, B, owner, stranger);
    page.doc.transact(() => page.doc.getMap('roomInfo').set('owner', owner.pid));
    put(page, root, theirs({ [A.pid]: '900', [B.pid]: '-900' }));
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, holder: owner.pub });
    expect(page.casino.computedResolutionOf(T, G.inc)).toMatchObject({ live: true, pending: false, holder: stranger.pub, invalid: [] });
    expect(chips(page, A)).toBe(100 + 900);
    expect(chips(page, B)).toBe(0); // (it never bought in: its balance reads from 0 up)
    // and the ledger it feeds has no author for a record either: a peer needs no game to give a player chips
    page.doc.transact(() => page.doc.getMap('casinoChips').set('peer:alice', { p: A.pid, d: 500, b: 0, c: 0, at: 0 }));
    expect(chips(page, A)).toBe(100 + 900 + 500);
  });

  it('what the owner\'s own game holds is not touched by it: its base, its holder and its nets stand', async () => {
    const { page, r1 } = await openedPage();
    const res = foldOf(r1.all);
    const before = chips(page, A);
    expect(before).toBe(100 + netOf(res, A));
    put(page, theirs({ [A.pid]: '900' }));
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true, holder: owner.pub });
    expect(page.casino.computedResolutionOf(T, P.inc)!.base).toMatchObject({ key: root.key });
    expect(chips(page, A)).toBe(before + 900);
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
      // a delegation of the shape it wants, padded past what a small record weighs: junk to the resolver, so to the page
      { key: delegationKey(house2.pub), value: padded(delegation(owner, house2.pub)) },
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

  it('with no checkpoint the game is not open: its session counts nothing and weighs nothing (it is no live session of anything), until one comes', async () => {
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
    expect(page.casino.computedRoomBytes()).toBe(0);
    // the checkpoint comes: the session is read whole, with the records that came before it, and weighed
    put(page, root);
    expect(chips(page, A)).toBe(100 + netOf(foldOf(r1.all), A) - 7);
    expect(page.casino.computedRoomBytes()).toBeGreaterThan(0);
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

  it('a trim put off that deletes the session the page counted leaves the table lost but not settled: nothing is spent until the check is made', async () => {
    const { page: a, r1 } = await openedPage();
    const counted = 100 + netOf(foldOf(r1.all), A);
    expect(chips(a, A)).toBe(counted);
    expect(a.casino.computedSettled()).toBe(true);
    // the trim comes with no time to check it: the session it replaces is gone, the root still stands
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    const trim = trimOf(P, 'p');
    trimTo(a, P, trim);
    expect(a.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: true });
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(root.key);
    expect(a.casino.casinoWhole(T)).toBe(false); // (lost: what it counted is not in the doc, and nothing is in its place yet)
    expect(a.casino.computedSettled(T)).toBe(false);
    expect(a.casino.computedSettled()).toBe(false); // (the lost table does not excuse a check that will be made)
    expect(chips(a, A)).toBe(counted); // (its last counts stand meanwhile)
    // the check made: the trim is the base, the table whole again, and spending goes on
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(a.casino.computedResolutionOf(T, P.inc)).toMatchObject({ pending: false });
    expect(a.casino.computedResolutionOf(T, P.inc)!.base?.key).toBe(trim.key);
    expect(a.casino.casinoWhole(T)).toBe(true);
    expect(a.casino.computedSettled()).toBe(true);
    expect(chips(a, A)).toBe(125);
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

  it('a delegation padded past what a small record weighs makes no house and moves nothing: found at bind, replaced or deleted after, and a good one put in its place counts', async () => {
    const a = await loadPage(1);
    a.casino.buyInChips(A.pid, 100);
    a.casino.buyInChips(B.pid, 100);
    pin(a, A, B);
    put(a, root);
    const second = houseRound(house2);
    putSession(a, P, SID, ...second);
    const key = delegationKey(house2.pub);
    put(a, { key, value: padded(delegation(owner, house2.pub)) });
    // the doc as a page finds it: bound to a copy that holds the padded delegation already
    const late = await loadPage(3);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.doc));
    late.casino.bindCasinoDoc(copy, ROOM);
    const res = () => late.casino.computedResolutionOf(T, P.inc)!;
    const before = res();
    expect(chips(late, A)).toBe(100 - 10);
    expect(chips(late, B)).toBe(100 - 5);
    // replaced by another padded one, then deleted: the game is not resolved again
    copy.transact(() => copy.getMap<unknown>('casinoComputed').set(key, padded({ ...delegation(owner, house2.pub), more: undefined })));
    expect(res()).toBe(before);
    copy.transact(() => copy.getMap<unknown>('casinoComputed').delete(key));
    expect(res()).toBe(before);
    // the same delegation, light: it is a house, and the round it decides counts
    const decided = foldOf(second, root.value, P, cachingCheck().check, housesAre(house2));
    copy.transact(() => copy.getMap<unknown>('casinoComputed').set(key, delegation(owner, house2.pub)));
    expect(res()).not.toBe(before);
    expect(chips(late, A)).toBe(100 + netOf(decided, A));
    expect(chips(late, B)).toBe(100 + netOf(decided, B));
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

// ── What a table plays ───────────────────────────────────────────────────────

/** The table's switch as the owner's page writes it (null: taken away). */
function switchTo(page: Page, inc: string | null): void {
  page.doc.transact(() => {
    const casino = page.doc.getMap('casino');
    if (inc === null) casino.delete(`cfg:computed:${T}`);
    else casino.set(`cfg:computed:${T}`, { v: 1, inc });
  });
}

/** The room's deed as the doc names it: `who`'s player id under `roomInfo.owner` (null: no one's).
 *  The page reads the owner's key from the pin (pin()). */
function deedTo(page: Page, who: TestIdentity | null): void {
  page.doc.transact(() => {
    const info = page.doc.getMap('roomInfo');
    if (who === null) info.delete('owner');
    else info.set('owner', who.pid);
  });
}

/** A game of its own that `who` opens at the table: its name binds their key, and its first house is the shared one. */
function gameBy(who: TestIdentity, j: string) {
  const name = { ...NAME, ok: who.pub, j };
  const ctx = ctxOf('p', T, name);
  const body = { v: 1, ok: who.pub, j, rv: name.rv, ts: name.ts, b: 'g', u: 0, l: NO_CLOSE, n: {}, dl: delegation(who, house.pub), k: who.pub };
  const rec = sealCk(ctx, body as unknown as Omit<CkRec, 'g'>, who.sign);
  return { ctx, name, root: rec, sid: nextSid3(ctx, rec.value) };
}
type Game = ReturnType<typeof gameBy>;
/** The owner's game and the buyer's, as `gameBy` makes the buyer's. */
const OWNERS: Game = { ctx: P, name: NAME, root, sid: SID };

/** The end of `g`, as its holder `who` signs it. */
function endOf(g: Game, who: TestIdentity) {
  const f = sealFin(g.ctx, who.pub, who.sign).value;
  return trimOf(g.ctx, 'p', { ok: g.name.ok, j: g.name.j, u: 5, l: hex('e', 32), e: 1, f, s: undefined, h: undefined, k: who.pub, dl: undefined, n: {} });
}

describe('the game a table plays (S9): the deed holder\'s, else the switch\'s, else the lowest name', () => {
  const played = (page: Page): string | null => page.casino.computedIncOf(T);
  const lowest = (...incs: string[]): string => [...incs].sort()[0];

  it('a table with one live game plays it, with no switch or one that names nothing of use', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    expect(played(a)).toBe(P.inc);
    expect(c.isComputedTable(T)).toBe(true);
    expect(c.isComputedFor(T, 'roulette')).toBe(true);
    expect(c.isComputedFor(T, 'craps')).toBe(false);
    expect(c.computedFoldOf(T)!.rounds.map((v) => v.decided)).toEqual(['house']);
    expect(c.computedSessionForWrite(T)).toBe(casinoComputed(a).get(sesKey(P, SID)));
    switchTo(a, `r${'0'.repeat(24)}`); // (an incarnation nothing stands behind)
    expect(played(a)).toBe(P.inc);
    expect(c.isComputedTable(T)).toBe(true);
    switchTo(a, null);
    expect(played(a)).toBe(P.inc);
  });

  it('a game with no base is no table, whether the switch names it or not: nothing is open (S4)', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    put(page, { key: ckKey(T, P.inc, hex('1', 32)), value: { junk: 1 } }); // (starts the game, which has no base)
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ base: null, live: false });
    expect(played(page)).toBeNull();
    expect(c.isComputedTable(T)).toBe(false);
    switchTo(page, P.inc);
    expect(played(page)).toBe(P.inc); // (the switch's name, as written)
    expect(c.isComputedTable(T)).toBe(false);
    expect(c.isComputedFor(T, 'roulette')).toBe(false);
    expect(c.computedSessionForWrite(T)).toBeNull();
    switchTo(page, Q.inc); // (and a name this page has seen nothing of)
    expect(c.isComputedTable(T)).toBe(false);
    expect(c.computedSessionForWrite(T)).toBeNull();
  });

  it('of two live games the table plays the one the deed holder holds, else the one the switch names, else the lowest name', async () => {
    const page = await loadPage(1);
    pin(page, owner, buyer, third);
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root, theirs.root);
    const [one, two] = [P.inc, theirs.ctx.inc];
    // the room names no one: the switch's, else the lowest name
    expect(played(page)).toBe(lowest(one, two));
    switchTo(page, one);
    expect(played(page)).toBe(one);
    switchTo(page, two);
    expect(played(page)).toBe(two);
    // the deed holder holds one of them: that one, whatever the switch names
    deedTo(page, owner);
    expect(played(page)).toBe(one);
    deedTo(page, buyer);
    switchTo(page, one);
    expect(played(page)).toBe(two);
    // someone who holds neither: the switch's again
    deedTo(page, third);
    expect(played(page)).toBe(one);
    switchTo(page, two);
    expect(played(page)).toBe(two);
    // and with no switch of use, the lowest
    switchTo(page, null);
    expect(played(page)).toBe(lowest(one, two));
  });

  it('a deed holder who holds both leaves the choice to the switch, then the lowest name', async () => {
    const page = await loadPage(1);
    pin(page, owner);
    deedTo(page, owner);
    put(page, root, root2); // (two games the owner opened)
    const both = [P.inc, P2.inc].sort();
    expect(played(page)).toBe(both[0]);
    switchTo(page, both[1]);
    expect(played(page)).toBe(both[1]);
  });

  it('a game whose holder changes is played by its new holder: S9 reads a game as it stands, not as it first was', async () => {
    const page = await loadPage(1);
    pin(page, owner, buyer);
    deedTo(page, buyer);
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root, theirs.root);
    switchTo(page, P.inc);
    // the deed holder holds one of the two: that one, whatever the switch names
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ holder: owner.pub, live: true });
    expect(played(page)).toBe(theirs.ctx.inc);
    // the owner hands its game to the buyer: the deed holder holds both, and the switch decides
    put(page, xferOf(P, owner, buyer, 1));
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ holder: buyer.pub, live: true });
    expect(played(page)).toBe(P.inc);
  });

  it('a game of another table is no game of this one: each table plays its own, and one with none plays what its switch names', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, owner);
    deedTo(page, owner);
    const T2 = 'roulette-2';
    const elsewhere = ctxOf('p', T2);
    expect(elsewhere.inc).not.toBe(P.inc); // (the name binds the table)
    put(page, rootOf(elsewhere, 'p'));
    expect(c.computedIncOf(T2)).toBe(elsewhere.inc);
    expect(c.isComputedTable(T2)).toBe(true);
    expect(played(page)).toBeNull(); // (this table has no game of its own)
    expect(c.isComputedTable(T)).toBe(false);
    const old = `r${'1'.repeat(24)}`;
    switchTo(page, old);
    expect(played(page)).toBe(old);
    put(page, root);
    expect(played(page)).toBe(P.inc);
    expect(c.computedIncOf(T2)).toBe(elsewhere.inc);
    expect(c.computedGameMovedOf(T)).toBeNull();
    expect(c.computedGameMovedOf(T2)).toBeNull();
  });

  it('a game that has ended is not played: the table goes to the other, and a switch naming the ended one changes nothing', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, owner, buyer);
    deedTo(page, owner);
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root, theirs.root);
    expect(played(page)).toBe(P.inc);
    put(page, endOf(OWNERS, owner));
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    expect(c.computedIncEnded(T, P.inc)).toBe(true);
    expect(c.computedIncEnded(T, theirs.ctx.inc)).toBe(false);
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(c.isComputedTable(T)).toBe(true);
    expect(c.computedGameMovedOf(T)).toEqual({ from: P.inc, to: theirs.ctx.inc }); // (the game it played ended)
    switchTo(page, P.inc);
    expect(played(page)).toBe(theirs.ctx.inc);
    // the other ends too: nothing is played, and the switch's name stands as written
    put(page, endOf(theirs, buyer));
    expect(c.computedResolutionOf(T, theirs.ctx.inc)).toMatchObject({ live: false });
    expect(c.computedIncEnded(T, theirs.ctx.inc)).toBe(true);
    expect(played(page)).toBe(P.inc);
    expect(c.isComputedTable(T)).toBe(false);
    expect(c.computedGameMovedOf(T)).toEqual({ from: P.inc, to: theirs.ctx.inc }); // (no move to a game that is not live)
  });

  it('a deed that changes hands moves the table\'s game with it: its view is told once, the card can say so, and no one\'s chips move', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    c.buyInChips(A.pid, 100);
    pin(page, A, B, owner, buyer, third);
    deedTo(page, owner);
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root, theirs.root);
    putSession(page, P, SID, ...round1().all);
    const before = chips(page, A);
    expect(before).not.toBe(100);
    expect(played(page)).toBe(P.inc);
    expect(c.computedGameMovedOf(T)).toBeNull();
    const heard = vi.fn();
    const off = c.subscribeCasinoKey(`computed:${T}`, heard);
    deedTo(page, buyer);
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(c.computedGameMovedOf(T)).toEqual({ from: P.inc, to: theirs.ctx.inc });
    const card = c.computedGameMovedOf(T)!;
    card.to = 'the card\'s own'; // (a copy: what the card does with it is not the page's)
    expect(c.computedGameMovedOf(T)).toEqual({ from: P.inc, to: theirs.ctx.inc });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(chips(page, A)).toBe(before); // (S9 sends new bets; it never moves what anyone's nets are)
    // a switch that names the other changes nothing while the deed holder holds one: nothing to tell
    switchTo(page, P.inc);
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(heard).toHaveBeenCalledTimes(1);
    // the deed goes to someone who holds neither: the switch's game, told once, and the card names the last move
    deedTo(page, third);
    expect(played(page)).toBe(P.inc);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(c.computedGameMovedOf(T)).toEqual({ from: theirs.ctx.inc, to: P.inc });
    // and with no deed holder to decide, the switch alone moves it, the view told once more
    switchTo(page, theirs.ctx.inc);
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(heard).toHaveBeenCalledTimes(3);
    expect(c.computedGameMovedOf(T)).toEqual({ from: P.inc, to: theirs.ctx.inc });
    off();
  });

  it('a deed holder\'s key that arrives after the deed does moves the table\'s game as a deed changing hands does: its view is told once, the card can say so', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, buyer);
    deedTo(page, owner); // (the room names the owner, but the owner's key is not in the players map yet)
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root, theirs.root);
    switchTo(page, theirs.ctx.inc);
    expect(played(page)).toBe(theirs.ctx.inc); // (no deed holder's key to go by: the switch's game)
    expect(c.computedGameMovedOf(T)).toEqual({ from: P.inc, to: theirs.ctx.inc });
    const heard = vi.fn();
    const off = c.subscribeCasinoKey(`computed:${T}`, heard);
    pin(page, owner); // (the owner's key shows up)
    expect(played(page)).toBe(P.inc);
    expect(c.computedGameMovedOf(T)).toEqual({ from: theirs.ctx.inc, to: P.inc });
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it('a page that comes to a doc where the deed has moved starts from what is there: nothing moved for it', async () => {
    const page = await loadPage(1);
    pin(page, owner, buyer);
    const theirs = gameBy(buyer, hex('4', 16));
    deedTo(page, buyer);
    put(page, root, theirs.root);
    const late = await loadPage(2);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(page.doc));
    late.casino.bindCasinoDoc(copy, ROOM);
    expect(late.casino.computedIncOf(T)).toBe(theirs.ctx.inc);
    expect(late.casino.computedGameMovedOf(T)).toBeNull();
    // and a page bound again, to another doc, forgets where its table's game moved before
    const before = Y.encodeStateAsUpdate(page.doc);
    deedTo(page, owner);
    expect(page.casino.computedIncOf(T)).toBe(P.inc);
    expect(page.casino.computedGameMovedOf(T)).toEqual({ from: theirs.ctx.inc, to: P.inc });
    const again = new Y.Doc();
    Y.applyUpdate(again, before);
    page.casino.bindCasinoDoc(again, ROOM);
    expect(page.casino.computedIncOf(T)).toBe(theirs.ctx.inc);
    expect(page.casino.computedGameMovedOf(T)).toBeNull();
    page.casino.bindCasinoDoc(new Y.Doc(), ROOM);
    expect(page.casino.computedIncOf(T)).toBeNull();
  });

  it('a page bound to another doc plays that doc\'s live games only: a game of the first is none of the second\'s', async () => {
    const page = await loadPage(1);
    pin(page, owner, buyer);
    deedTo(page, owner);
    put(page, root);
    expect(played(page)).toBe(P.inc);
    // the other doc holds the buyer's game alone, the deed still the owner's (who holds none there)
    const there = await loadPage(2);
    pin(there, owner, buyer);
    deedTo(there, owner);
    const theirs = gameBy(buyer, hex('4', 16));
    put(there, theirs.root);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(there.doc));
    page.casino.bindCasinoDoc(copy, ROOM);
    expect(page.casino.computedResolutionOf(T, P.inc)).toBeNull();
    expect(played(page)).toBe(theirs.ctx.inc);
  });

  it('the game ending, or a game opening where none was played, is not a move of the table\'s game', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, owner, buyer);
    deedTo(page, owner);
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root);
    expect(played(page)).toBe(P.inc);
    put(page, endOf(OWNERS, owner)); // the only game ends: the table plays none
    expect(played(page)).toBeNull();
    expect(c.computedGameMovedOf(T)).toBeNull();
    put(page, theirs.root); // another opens: from none to a game is the table opening, not moving
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(c.computedGameMovedOf(T)).toBeNull();
  });

  it('is looked at again for the tables that may have moved only: a game of theirs resolved again, their switch, or the deed holder; no other transaction looks at any table', async () => {
    const page = await loadPage(1);
    pin(page, owner, buyer);
    deedTo(page, owner);
    const others = ['roulette-2', 'roulette-3', 'roulette-4'].map((t) => ctxOf('p', t));
    put(page, root, ...others.map((g) => rootOf(g, 'p')));
    const looks = (act: () => void): number => {
      const before = asked.tableGame;
      act();
      return asked.tableGame - before;
    };
    // a transaction of the doc that touches none of it
    expect(looks(() => page.doc.transact(() => page.doc.getMap('casino').set('cfg:elsewhere', 1)))).toBe(0);
    expect(looks(() => page.doc.transact(() => page.doc.getMap('roomInfo').set('motto', 'x')))).toBe(0);
    // junk under a game's record keys moves nothing: the game is not resolved again, no table is looked at
    expect(looks(() => put(page, { key: ckKey(others[0].t, others[0].inc, hex('1', 32)), value: { junk: 1 } }))).toBe(0);
    // another table's switch
    const elsewhere = (inc: string | null) => page.doc.transact(() => {
      if (inc === null) page.doc.getMap('casino').delete('cfg:computed:somewhere');
      else page.doc.getMap('casino').set('cfg:computed:somewhere', { v: 1, inc });
    });
    expect(looks(() => elsewhere(`r${'1'.repeat(24)}`))).toBe(0);
    // this table's switch: this table alone (not the three others)
    const one = looks(() => switchTo(page, P.inc));
    expect(one).toBeGreaterThanOrEqual(1);
    expect(one).toBeLessThan(4);
    // a game of this table resolved again (its end, after which S9 has none to choose among): not the three others
    const two = looks(() => put(page, endOf(OWNERS, owner)));
    expect(two).toBeLessThan(3);
    // and the deed holder moving: every table with a live game (this table's has ended)
    const three = looks(() => deedTo(page, buyer));
    expect(three).toBeGreaterThanOrEqual(3);
    // and once looked at, a table is not looked at again by a transaction that moves none of it
    expect(looks(() => page.doc.transact(() => page.doc.getMap('casino').set('cfg:elsewhere', 2)))).toBe(0);
  });

  it('asks S9 about the live games of a table only: games with no base, which junk under a well-formed key starts, cost a call nothing', async () => {
    const page = await loadPage(1);
    put(page, root);
    for (let i = 0; i < 40; i++) {
      const junk = ctxOf('p', T, { ...NAME, j: String(1000 + i).padStart(16, '0') });
      put(page, { key: ckKey(T, junk.inc, hex('1', 32)), value: { junk: 1 } });
    }
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
    asked.games = -1;
    expect(page.casino.computedIncOf(T)).toBe(P.inc);
    expect(asked.games).toBe(1);
    put(page, endOf(OWNERS, owner)); // (it ends: no game of the table is live)
    asked.games = -1;
    expect(page.casino.computedIncOf(T)).toBeNull();
    expect(asked.games).toBe(-1); // (S9 is not asked: nothing is live)
  });

  it('a switch moved from one page-signed incarnation to another tells the view at a table that has a FAIR ONLY game of no use too', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    const x = `r${'1'.repeat(24)}`;
    const y = `r${'2'.repeat(24)}`;
    put(page, { key: ckKey(T, P.inc, hex('1', 32)), value: { junk: 1 } }); // (a game with no base)
    c.writeComputedOn(T, x);
    expect(played(page)).toBe(x);
    const heard = vi.fn();
    const off = c.subscribeCasinoKey(`computed:${T}`, heard);
    c.writeComputedOn(T, y);
    expect(played(page)).toBe(y);
    expect(heard).toHaveBeenCalled();
    off();
  });

  it('the only game ending while the switch still names it, then another opening, is an opening and not a move between them: the dead name is a hint, not a game played', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, owner, buyer);
    deedTo(page, owner);
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, root);
    switchTo(page, P.inc);
    expect(played(page)).toBe(P.inc);
    const heard = vi.fn();
    const off = c.subscribeCasinoKey(`computed:${T}`, heard);
    put(page, endOf(OWNERS, owner));
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    expect(played(page)).toBe(P.inc); // (the switch's name as written: nothing stands behind it)
    expect(c.isComputedTable(T)).toBe(false);
    expect(heard).toHaveBeenCalled(); // (the table stopped: its view is told)
    heard.mockClear();
    put(page, theirs.root);
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(c.computedGameMovedOf(T)).toBeNull(); // (the table played none in between)
    expect(heard).toHaveBeenCalled();
    off();
  });

  it('a game ending to the page-signed table the switch names, or a game opening over one, is no move between FAIR ONLY games', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, owner, buyer);
    deedTo(page, owner);
    const old = `r${'1'.repeat(24)}`;
    put(page, root);
    c.writeComputedOn(T, old); // (the switch names a page-signed incarnation, which has a live session)
    expect(played(page)).toBe(P.inc);
    put(page, endOf(OWNERS, owner));
    expect(played(page)).toBe(old);
    expect(c.computedGameMovedOf(T)).toBeNull();
    const theirs = gameBy(buyer, hex('4', 16));
    put(page, theirs.root);
    expect(played(page)).toBe(theirs.ctx.inc); // (a live game is played over the switch's page-signed incarnation)
    expect(c.computedGameMovedOf(T)).toBeNull();
  });

  // What the page-signed duties of a table go by to know a game was played at it since they last ran: the
  // count of the moves of its game to or from a live one, the doc's (computedGameMovesOf).
  it('counts the moves of the table\'s game to or from a live game: a game opening, ending, or the deed changing hands; not a switch among page-signed incarnations, a hint, nor the first look at the table', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    pin(page, owner, buyer, third);
    deedTo(page, owner);
    const theirs = gameBy(buyer, hex('4', 16));
    const x = `r${'1'.repeat(24)}`;
    const moves = (): number => c.computedGameMovesOf(T);
    expect(moves()).toBe(0);
    c.writeComputedOn(T, x); // (a page-signed incarnation: no game has a part in it)
    expect(moves()).toBe(0);
    put(page, root); // the owner's game opens over it: the first look at the table moves nothing
    expect(played(page)).toBe(P.inc);
    expect(moves()).toBe(0);
    put(page, theirs.root); // another opens: the deed holder's is played still
    expect(played(page)).toBe(P.inc);
    expect(moves()).toBe(0);
    deedTo(page, buyer); // the deed changes hands: the table goes from one game to the other
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(moves()).toBe(1);
    switchTo(page, P.inc); // a hint at the game not played moves nothing
    expect(played(page)).toBe(theirs.ctx.inc);
    expect(moves()).toBe(1);
    put(page, endOf(theirs, buyer)); // the game it played ends: the other is played
    expect(played(page)).toBe(P.inc);
    expect(moves()).toBe(2);
    put(page, endOf(OWNERS, owner)); // the last one ends: no game is played, whatever the switch still names
    expect(c.isComputedTable(T)).toBe(false);
    expect(moves()).toBe(3);
    c.writeComputedOn(T, x); // the table goes back to the page-signed incarnation: its end was counted
    expect(played(page)).toBe(x);
    expect(moves()).toBe(3);
    const again = gameBy(third, hex('5', 16));
    put(page, again.root); // a game opens at it again
    expect(played(page)).toBe(again.ctx.inc);
    expect(moves()).toBe(4);
    put(page, endOf(again, third));
    expect(played(page)).toBe(x);
    expect(moves()).toBe(5);
    expect(c.computedGameMovesOf('roulette-2')).toBe(0); // (the count is of a table)
  });

  it('counts nothing of a game played before the page bound the doc: its end is the first move it counts, and a binding forgets the count', async () => {
    const page = await loadPage(1);
    pin(page, owner);
    deedTo(page, owner);
    put(page, root);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(page.doc));
    const late = await loadPage(2);
    late.casino.bindCasinoDoc(copy, ROOM);
    late.doc = copy;
    expect(late.casino.computedIncOf(T)).toBe(P.inc);
    expect(late.casino.computedGameMovesOf(T)).toBe(0); // (it found the game played)
    put(late, endOf(OWNERS, owner));
    expect(late.casino.computedGameMovesOf(T)).toBe(1); // (and saw it end)
    const over = new Y.Doc();
    Y.applyUpdate(over, Y.encodeStateAsUpdate(late.doc));
    late.casino.bindCasinoDoc(over, ROOM);
    expect(late.casino.computedGameMovesOf(T)).toBe(0);
  });
});

// ── The switch at a FAIR ONLY table ──────────────────────────────────────────

describe('a switch that names a FAIR ONLY game: a hint the page-signed machinery leaves alone', () => {
  it('reads a FAIR ONLY name as a name, and anything else of the shape as none', async () => {
    const { casino: c } = await loadPage(1);
    const old = `r${'0'.repeat(24)}`;
    expect(c.computedCfgInc({ v: 1, inc: P.inc })).toBe(P.inc);
    expect(c.computedCfgInc({ v: 1, inc: Q.inc })).toBe(Q.inc);
    expect(c.computedCfgInc({ v: 1, inc: old })).toBe(old);
    for (const junk of [
      { v: 1, inc: `${P.inc}0` }, { v: 1, inc: P.inc.slice(1) }, { v: 1, inc: `p${'G'.repeat(24)}` }, { v: 1, inc: `s${'0'.repeat(24)}` },
      { v: 2, inc: P.inc }, { v: 1, inc: P.inc, at: 1 }, { inc: P.inc }, [P.inc], P.inc, null, undefined,
    ]) expect(c.computedCfgInc(junk)).toBeNull();
  });

  it('is nothing the table ends with, and nothing a peer\'s gone: mark or a removal can end the game by (S7)', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    const casino = a.doc.getMap('casino');
    const gone = () => [...casino.keys()].filter((k) => k.startsWith(`gone:${T}:${P.inc}`));
    switchTo(a, P.inc);
    // the owner's switch-off: the switch goes, nothing is marked ended, the game goes on being played
    c.writeComputedOff(T);
    expect(casino.has(`cfg:computed:${T}`)).toBe(false);
    expect(gone()).toEqual([]);
    expect(c.computedIncEnded(T, P.inc)).toBe(false);
    expect(c.isComputedTable(T)).toBe(true);
    // a mark a peer writes is nothing to it
    a.doc.transact(() => casino.set(`gone:${T}:${P.inc}`, 1));
    expect(c.computedIncEnded(T, P.inc)).toBe(false);
    expect(c.isComputedTable(T)).toBe(true);
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
    // and the page that takes the table out of the room marks nothing of it either
    a.doc.transact(() => casino.delete(`gone:${T}:${P.inc}`));
    switchTo(a, P.inc);
    c.clearTableKeys(T, 'local');
    expect(gone()).toEqual([]);
    expect(casino.has(`cfg:computed:${T}`)).toBe(false);
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
    expect(c.isComputedTable(T)).toBe(true);
  });

  it('a removal marks nothing of a FAIR ONLY game the switch does not name either, and ends the page-signed incarnation beside it', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    const casino = a.doc.getMap('casino');
    const old = `r${'1'.repeat(24)}`;
    a.doc.transact(() => casinoComputed(a).set(`ses:${T}:${old}:g`, new Y.Map())); // (a page-signed incarnation, live, its switch gone)
    expect(c.computedIncEnded(T, old)).toBe(false);
    c.clearTableKeys(T, 'local');
    expect(casino.has(`gone:${T}:${old}`)).toBe(true); // (the page-signed incarnation, live, the switch naming it or not)
    expect(casino.has(`gone:${T}:${P.inc}`)).toBe(false);
    expect(c.computedIncEnded(T, old)).toBe(true);
    expect(c.computedIncEnded(T, P.inc)).toBe(false);
  });

  it('is not a switch left bare, nor lost: a name nothing stands behind drops nothing, and no peer\'s switch makes a page put one back', async () => {
    const page = await loadPage(1);
    const c = page.casino;
    switchTo(page, Q.inc); // (a FAIR ONLY name this page has nothing of)
    expect(c.computedSwitchBare(T)).toBe(false);
    expect(c.computedSwitchLost(T)).toBe(false);
    expect(c.computedIncOf(T)).toBe(Q.inc);
    const { page: a } = await openedPage();
    switchTo(a, P.inc);
    expect(a.casino.computedSwitchBare(T)).toBe(false);
    expect(a.casino.computedSwitchLost(T)).toBe(false);
    switchTo(a, null);
    expect(a.casino.computedSwitchLost(T)).toBe(false);
    expect(a.casino.putComputedSwitchBack(T, P.inc)).toBe(false);
    expect(a.doc.getMap('casino').has(`cfg:computed:${T}`)).toBe(false);
  });

  it('with the switch naming the game, no recovery, finalising or trim of a page-signed table writes anything of it, open or lost', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    switchTo(a, P.inc);
    const end = kit.checkpoint(owner, 'g', 1, hex('1', 32), {}, 1);
    const next = kit.checkpoint(owner, nextSid(P, root.value), 1, hex('1', 32), {}); // (what a trim of a page-signed table writes)
    const refused = (): void => {
      expect(c.writeCheckpointAndTrim(T, P.inc, next, [])).toBe(false);
      expect(c.finalizeComputed(T, P.inc, end)).toBe(false);
      expect(c.finalizeComputed(T, P.inc, null)).toBe(false);
      expect(c.putComputedSwitchBack(T, P.inc)).toBe(false);
      expect(c.writeComputedGone(T, P.inc)).toBe(false);
      expect(c.reopenComputedSession(T, P.inc)).toBe(false);
      expect(c.giveUpComputed(T, P.inc)).toBe(false);
      expect(c.giveWayComputed(T, P.inc)).toBe(false);
      expect(c.restoreComputedCheckpoint(T, P.inc, root.value)).toBe(false);
      expect(c.computedRestorePending(T, P.inc)).toBe(false);
      expect(c.computedRestorePending(T)).toBe(false);
      expect(c.computedCheckpointBroken(T)).toBe(false);
    };
    const before = Y.encodeStateAsUpdate(a.doc);
    refused();
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(before);
    // its counted session gone: a page-signed table's page would open another or give the rounds up
    a.doc.transact(() => casinoComputed(a).delete(sesKey(P, SID)));
    expect(c.casinoWhole(T)).toBe(false);
    const lost = Y.encodeStateAsUpdate(a.doc);
    refused();
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(lost);
    expect(c.casinoWhole(T)).toBe(false); // (and nothing gave its rounds up: it is lost still)
    expect(c.computedGaveUp(T)).toBeNull();
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
  });

  it('is in none of the lists the recovery and the compaction of page-signed tables go by, the switch naming it or not', async () => {
    const { page: a } = await openedPage();
    const c = a.casino;
    const lists = () => ({
      recoveries: c.computedRecoveries().filter((r) => r.t === T), pending: c.computedRecoveryPending(), ended: c.computedEndedIncs(), live: c.computedLiveTables(),
    });
    switchTo(a, P.inc);
    expect(lists()).toEqual({ recoveries: [], pending: false, ended: [], live: [] });
    put(a, endOf(OWNERS, owner));
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    expect(lists()).toEqual({ recoveries: [], pending: false, ended: [], live: [] });
  });

  it('is played by no duty of a page-signed table yet: its state is none, a frame writes nothing, and a slip is refused (PR 6c-4b opens them one by one)', async () => {
    const { page: a } = await openedPage();
    const table = await import('./computedTable'); // (the load of the modules the page is)
    switchTo(a, P.inc);
    expect(a.casino.isComputedTable(T)).toBe(true);
    expect(table.readComputedRoulette(T)).toBeNull();
    expect(table.readComputedBets(T, 2)).toEqual({});
    const before = Y.encodeStateAsUpdate(a.doc);
    for (const at of [1_700_000_100_000, 1_700_000_400_000, 1_700_003_000_000]) table.tickComputedTables([T], at);
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(before);
    expect(table.writeComputedSlip(T, [red(5)])).not.toMatchObject({ ok: true });
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(before);
  });
});

// ── A page-signed table beside a FAIR ONLY game ──────────────────────────────

describe('a page-signed table beside a FAIR ONLY game: its switch is still its own', () => {
  const X = `r${'1'.repeat(24)}`;
  /** An opened game, and beside it a page-signed incarnation the switch names (as the house switches one on). */
  const beside = async () => {
    const { page } = await openedPage();
    page.casino.writeComputedOn(T, X);
    return page;
  };
  const casinoOf = (page: Page): Y.Map<unknown> => page.doc.getMap('casino');
  const goneOf = (page: Page): string[] => [...casinoOf(page).keys()].filter((k) => k.startsWith('gone:') && k !== `gone:${T}:`).sort();

  it('the table plays the game, and the owner\'s switch-off ends the page-signed incarnation the switch names, not the game', async () => {
    const page = await beside();
    const c = page.casino;
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.isComputedTable(T)).toBe(true);
    expect(c.computedLiveTables()).toEqual([{ t: T, inc: X }]); // (the page-signed one: awayDuty ends it with the table's room)
    c.writeComputedOff(T);
    expect(goneOf(page)).toEqual([`gone:${T}:${X}`]);
    expect(casinoOf(page).has(`cfg:computed:${T}`)).toBe(false);
    expect(c.computedIncEnded(T, X)).toBe(true);
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.computedLiveTables()).toEqual([]);
  });

  it('a page that ran it ends it as its removal does, and the game goes on', async () => {
    const page = await beside();
    const c = page.casino;
    expect(c.writeComputedGone(T, P.inc)).toBe(false);
    expect(c.writeComputedGone(T, X)).toBe(true);
    expect(goneOf(page)).toEqual([`gone:${T}:${X}`]);
    expect(casinoOf(page).has(`cfg:computed:${T}`)).toBe(false);
    expect(c.isComputedTable(T)).toBe(true);
    const other = await beside();
    other.casino.clearTableKeys(T, 'local');
    expect(casinoOf(other).has(`gone:${T}:${X}`)).toBe(true);
    expect(casinoOf(other).has(`gone:${T}:${P.inc}`)).toBe(false);
  });

  it('a removal marks the page-signed name the switch carries ended even when the doc holds nothing of it, beside a live game: a record that turns up under that name later is an ended incarnation\'s', async () => {
    const { page } = await openedPage();
    const c = page.casino;
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
    const bare = `r${'7'.repeat(24)}`;
    switchTo(page, bare); // (a bare switch: a name nothing in the doc stands behind)
    expect(c.computedIncOf(T)).toBe(P.inc);
    c.clearTableKeys(T, 'local');
    expect(c.computedIncEnded(T, bare)).toBe(true);
    expect(casinoOf(page).has(`gone:${T}:${bare}`)).toBe(true);
    expect(casinoOf(page).has(`gone:${T}:${P.inc}`)).toBe(false);
    expect(casinoOf(page).has(`cfg:computed:${T}`)).toBe(false);
  });

  it('a switch a peer took away is lost, and put back: the game is not the page-signed table\'s to stand for', async () => {
    const page = await beside();
    const c = page.casino;
    expect(c.computedSwitchLost(T)).toBe(false);
    switchTo(page, null);
    expect(c.computedSwitchLost(T)).toBe(true);
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.putComputedSwitchBack(T, P.inc)).toBe(false);
    expect(c.putComputedSwitchBack(T, X)).toBe(true);
    expect(casinoOf(page).get(`cfg:computed:${T}`)).toEqual({ v: 1, inc: X });
    expect(c.computedSwitchLost(T)).toBe(false);
  });

  it('a switch naming a live game is the game\'s hint: not lost and not put back over, with the page-signed incarnation live beside it', async () => {
    const page = await beside();
    const c = page.casino;
    switchTo(page, P.inc);
    expect(c.computedSwitchLost(T)).toBe(false);
    expect(c.computedSwitchLost(T, 'roulette')).toBe(false);
    expect(c.computedSwitchLost(T, 'craps')).toBe(false); // (no craps incarnation is live here to lose it)
    expect(c.putComputedSwitchBack(T, X)).toBe(false);
    expect(casinoOf(page).get(`cfg:computed:${T}`)).toEqual({ v: 1, inc: P.inc });
  });

  it('asked after one game, a switch naming the other game\'s live incarnation names none of this one\'s: lost, with a page-signed incarnation of this one live beside it', async () => {
    const page = await beside();
    const c = page.casino;
    const K = `k${'3'.repeat(24)}`;
    c.writeComputedOn(T, K); // (a live craps incarnation, which the switch names now)
    expect(c.computedSwitchLost(T)).toBe(false);
    expect(c.computedSwitchLost(T, 'craps')).toBe(false);
    expect(c.computedSwitchLost(T, 'roulette')).toBe(true); // (X is roulette's, live, and the switch names none of roulette's)
  });

  it('a switch naming a FAIR ONLY game that is not live (a name nothing opened, junk records and no base, or an ended game) is lost with the page-signed incarnation live beside it, and put back, as an ended page-signed name is', async () => {
    const page = await beside();
    const c = page.casino;
    const put0 = (): void => expect(c.putComputedSwitchBack(T, X)).toBe(true);
    // a name the doc holds nothing of
    switchTo(page, Q.inc);
    expect(c.computedSwitchLost(T)).toBe(true);
    put0();
    expect(casinoOf(page).get(`cfg:computed:${T}`)).toEqual({ v: 1, inc: X });
    expect(c.computedSwitchLost(T)).toBe(false);
    // junk under a well-formed key starts the game, which has no base: no more open than the name above
    put(page, { key: ckKey(T, Q.inc, hex('1', 32)), value: { junk: 1 } });
    expect(c.computedResolutionOf(T, Q.inc)).toMatchObject({ base: null, live: false });
    expect(c.computedIncEnded(T, Q.inc)).toBe(false);
    switchTo(page, Q.inc);
    expect(c.computedSwitchLost(T)).toBe(true);
    put0();
    expect(casinoOf(page).get(`cfg:computed:${T}`)).toEqual({ v: 1, inc: X });
    // and a game that has ended
    pin(page, owner);
    put(page, endOf(OWNERS, owner));
    expect(c.computedIncEnded(T, P.inc)).toBe(true);
    switchTo(page, P.inc);
    expect(c.computedSwitchLost(T)).toBe(true);
    expect(c.computedIncOf(T)).toBe(P.inc); // (the switch\'s name as written; the table plays nothing under it)
    expect(c.isComputedTable(T)).toBe(false);
    put0();
    expect(c.computedIncOf(T)).toBe(X);
    expect(c.isComputedTable(T)).toBe(true);
    expect(c.computedSwitchLost(T)).toBe(false);
  });

  it('the same dead names beside no page-signed incarnation are nothing to repair: not lost, and nothing to put back over', async () => {
    const { page } = await openedPage();
    const c = page.casino;
    pin(page, owner);
    put(page, endOf(OWNERS, owner));
    switchTo(page, P.inc);
    expect(c.computedSwitchLost(T)).toBe(false);
    switchTo(page, Q.inc);
    expect(c.computedSwitchLost(T)).toBe(false);
    expect(c.putComputedSwitchBack(T, `r${'1'.repeat(24)}`)).toBe(false); // (an incarnation nothing holds a session of)
    expect(page.doc.getMap('casino').get(`cfg:computed:${T}`)).toEqual({ v: 1, inc: Q.inc });
  });

  it('is listed for the room\'s away duty while the switch names it and nothing has ended it, whichever game is played', async () => {
    const page = await beside();
    const c = page.casino;
    expect(c.computedLiveTables()).toEqual([{ t: T, inc: X }]);
    page.doc.transact(() => casinoOf(page).set(`gone:${T}:${X}`, 1)); // (ended, and the switch still names it)
    expect(c.computedIncEnded(T, X)).toBe(true);
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.computedLiveTables()).toEqual([]);
  });

  it('is not an ended incarnation for compaction while the switch names a live game: the name is a hint, and the page-signed incarnation only waits', async () => {
    const page = await beside();
    const c = page.casino;
    const ended = (): string[] => c.computedEndedIncs().map((e) => `${e.t}:${e.inc}`);
    const Y2 = `r${'4'.repeat(24)}`;
    expect(ended()).toEqual([]); // (the switch names it)
    switchTo(page, P.inc);
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.computedEndedIncs()).toEqual([]);
    // the same as ever: a missing switch, or the name of a game that is not live, is no incarnation holding it
    switchTo(page, null);
    expect(ended()).toEqual([`${T}:${X}`]);
    switchTo(page, Q.inc);
    expect(c.computedResolutionOf(T, Q.inc)).toBeNull(); // (a name nothing opened: a dead hint)
    expect(ended()).toEqual([`${T}:${X}`]);
    switchTo(page, P.inc);
    expect(ended()).toEqual([]);
    // another page-signed incarnation's name takes its place; the game's name is the place of neither,
    // and no way back to the one the switch left: it holds the other, whose place it is
    c.writeComputedOn(T, Y2);
    expect(ended()).toEqual([`${T}:${X}`]);
    switchTo(page, P.inc);
    expect(ended()).toEqual([`${T}:${X}`]);
    // and a removal still ends it, the switch naming the game or not
    page.doc.transact(() => casinoOf(page).set(`gone:${T}:${X}`, 1));
    expect(ended()).toEqual([`${T}:${X}`]);
    page.doc.transact(() => casinoOf(page).set(`gone:${T}:${Y2}`, 1));
    expect(ended()).toEqual([`${T}:${X}`, `${T}:${Y2}`]);
  });

  it('waits no longer when the game it waited beside ends: its name in the switch is a dead hint then, put back over as a missing switch is', async () => {
    const page = await beside();
    const c = page.casino;
    pin(page, owner);
    switchTo(page, P.inc);
    expect(c.computedEndedIncs()).toEqual([]);
    put(page, endOf(OWNERS, owner));
    expect(c.computedResolutionOf(T, P.inc)).toMatchObject({ live: false });
    // (the page puts the dead name back over in its turn, before compaction looks: until then the switch names nothing that holds it)
    expect(c.computedEndedIncs().map((e) => `${e.t}:${e.inc}`)).toEqual([`${T}:${X}`]);
    expect(c.putComputedSwitchBack(T, X)).toBe(true);
    expect(c.computedEndedIncs()).toEqual([]);
  });

  it('a restore in motion at the page-signed table the switch names is that table\'s, whichever game is played', async () => {
    const page = await beside();
    const c = page.casino;
    const kx = new ComputedKit({ room: ROOM, t: T, inc: X });
    const head = kx.checkpoint(owner, 'g', 2, hex('1', 32), {});
    const older = kx.checkpoint(owner, 'g', 1, hex('2', 32), {});
    const sum = `sum:${T}:${X}`;
    page.doc.transact(() => casinoComputed(page).set(sum, head));
    expect(c.computedRestorePending(T, X)).toBe(false);
    page.doc.transact(() => casinoComputed(page).set(sum, older)); // (a replay below the head this page counted)
    expect(c.computedRestorePending(T, X)).toBe(true);
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.computedRestorePending(T)).toBe(true); // (the default is the switch's: the page-signed table the restore is of)
    expect(c.computedRestorePending(T, P.inc)).toBe(false);
  });

  it('a switch nothing stands behind is bare, the game played or not', async () => {
    const { page } = await openedPage();
    const c = page.casino;
    switchTo(page, `r${'2'.repeat(24)}`);
    expect(c.computedIncOf(T)).toBe(P.inc);
    expect(c.computedSwitchBare(T)).toBe(true);
    switchTo(page, Q.inc);
    expect(c.computedSwitchBare(T)).toBe(false);
  });

  it('the robot drops a bare switch beside a game as it does at any table, and starts its watch afresh when another is put in its place', async () => {
    const { page } = await openedPage();
    const croupier = await import('./croupier'); // (the load of the modules the page is)
    const lapse = croupier.TABLE_LEASE_LAPSE_MS;
    const casino = page.doc.getMap('casino');
    const bare = `r${'2'.repeat(24)}`;
    switchTo(page, bare);
    expect(croupier.dropBareSwitch(T, 1_000)).toBe(false);
    switchTo(page, `r${'3'.repeat(24)}`); // (another: the watch starts afresh)
    expect(croupier.dropBareSwitch(T, 1_000 + lapse - 1)).toBe(false);
    expect(croupier.dropBareSwitch(T, 1_000 + 2 * lapse - 2)).toBe(false);
    expect(casino.has(`cfg:computed:${T}`)).toBe(true);
    expect(croupier.dropBareSwitch(T, 1_000 + 2 * lapse - 1)).toBe(true);
    expect(casino.has(`cfg:computed:${T}`)).toBe(false);
    expect(page.casino.computedResolutionOf(T, P.inc)).toMatchObject({ live: true });
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
