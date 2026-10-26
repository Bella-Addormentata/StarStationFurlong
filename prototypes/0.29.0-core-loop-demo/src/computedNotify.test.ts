/**
 * 🧮🔔 How often listeners are told of a computed table's records: once per
 * transaction, as for every other casino write (chipNotify.test.ts), on the
 * page that writes a record and on every page that hears it, a transaction
 * of `casinoComputed` alone included (told after the transaction), and the
 * empty transaction a verification slice runs in too. A bal: listener is
 * told only when the player's chips moved, and reads them as they are.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { pocketOf } from './computedFold';
import type { Checkpoint, SlipRec } from './computedFold';
import { black, ComputedKit, red, straight, TEST_CTX, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import type { RouletteBet } from './games/roulette';

type Page = {
  casino: typeof import('./casinoDoc');
  doc: Y.Doc;
};

const OWNER = 'owner-Alice';

vi.stubGlobal('window', { location: { search: '' } });

vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  getPlayerId: () => OWNER,
}));

/** A page whose checks never run out of time unless a spec says so. */
async function loadPage(clientID: number): Promise<Page> {
  vi.resetModules();
  const casino = await import('./casinoDoc');
  const doc = new Y.Doc();
  doc.clientID = clientID;
  casino.setComputedVerifyForTests({ now: () => 0 });
  casino.bindCasinoDoc(doc);
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

afterEach(() => {
  vi.restoreAllMocks();
});

const TABLE = 'roulette-1';
const INC = TEST_CTX.inc;
const kit = new ComputedKit({ room: '', t: TABLE, inc: INC });
const AMY = testIdentity('amy', 'player-Amy');
const BOB = testIdentity('bob', 'player-Bob');

const pocket1 = pocketOf(kit.ctx, 1, [kit.seed(AMY.pid, 1), kit.seed(BOB.pid, 1)]);
/** Amy's straight on round 1's pocket wins; Bob's misses. */
const amyBets: RouletteBet[] = [straight(pocket1, 2)];
const bobBets: RouletteBet[] = [straight((pocket1 + 1) % 37, 3)];

function pin(page: Page, ...ids: TestIdentity[]): void {
  page.doc.transact(() => {
    for (const id of ids) page.doc.getMap('players').set(id.pid, { keyB64: id.pub });
  });
}

function switchOn(page: Page): void {
  page.doc.transact(() => {
    page.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
    page.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map());
  });
}

function put(page: Page, ...recs: Built<unknown>[]): void {
  const ses = page.casino.computedSessionForWrite(TABLE)!;
  page.doc.transact(() => {
    for (const r of recs) ses.set(r.key, r.rec);
  });
}

/** What one page's listeners heard: every notify, a computed table's view
 *  key, and each player's bal: key with what it read then. */
interface Heard {
  all: number;
  view: number;
  amy: number[];
  bob: number[];
}

function listen(page: Page): Heard {
  const heard: Heard = { all: 0, view: 0, amy: [], bob: [] };
  page.casino.subscribeCasino(() => { heard.all += 1; });
  page.casino.subscribeCasinoKey(`computed:${TABLE}`, () => { heard.view += 1; });
  page.casino.subscribeCasinoKey(`bal:${AMY.pid}`, () => { heard.amy.push(page.casino.readChips(AMY.pid)); });
  page.casino.subscribeCasinoKey(`bal:${BOB.pid}`, () => { heard.bob.push(page.casino.readChips(BOB.pid)); });
  return heard;
}

/** Two pages, Amy and Bob with 100 chips each and their keys pinned, the
 *  table switched on, and round 1's slips down. */
async function table(): Promise<{ a: Page; b: Page; sa: Built<SlipRec>; sb: Built<SlipRec> }> {
  const a = await loadPage(1);
  const b = await loadPage(2);
  a.casino.buyInChips(AMY.pid, 100);
  a.casino.buyInChips(BOB.pid, 100);
  pin(a, AMY, BOB);
  switchOn(a);
  const sa = kit.slip(AMY, 1, amyBets);
  const sb = kit.slip(BOB, 1, bobBets);
  put(a, sa, sb);
  sync(a, b);
  return { a, b, sa, sb };
}

/** Run one write on page a, then hand it to page b: what each heard. */
function step(a: Page, b: Page, write: () => void): [Heard, Heard] {
  const heard: [Heard, Heard] = [listen(a), listen(b)];
  write();
  sync(a, b);
  return heard;
}

describe('one notify per transaction of computed records', () => {
  it('a slip: told once, with the stake held', async () => {
    const { a, b } = await table();
    const heard = step(a, b, () => put(a, kit.slip(AMY, 1, [...amyBets, red(10)], { v: 2 })));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [100 - 12], bob: [] });
  });

  it('a close: told once, and no bal: listener (the stakes it froze were held already)', async () => {
    const { a, b, sa, sb } = await table();
    const heard = step(a, b, () => put(a, kit.close(AMY, 1, 'g', [sa, sb])));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [], bob: [] });
  });

  it('the deciding reveal: told once, each stake paid as it stops being held', async () => {
    const { a, b, sa, sb } = await table();
    put(a, kit.close(AMY, 1, 'g', [sa, sb]), kit.reveal(1, AMY.pid));
    sync(a, b);
    const heard = step(a, b, () => put(a, kit.reveal(1, BOB.pid)));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [100 + 70], bob: [97] });
  });

  it('a forfeit: told once, the bettor whose seed is out paid nothing back', async () => {
    const { a, b, sa, sb } = await table();
    const close = kit.close(AMY, 1, 'g', [sa, sb]);
    put(a, close, kit.reveal(1, AMY.pid));
    sync(a, b);
    const heard = step(a, b, () => put(a, kit.forfeit(AMY, 1, close.hash, [AMY.pid])));
    const pocket = pocketOf(kit.ctx, 1, [kit.seed(AMY.pid, 1)]);
    const amyNow = 100 - 2 + (pocket === pocket1 ? 72 : 0);
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [amyNow], bob: [97] });
    expect(a.casino.computedFoldOf(TABLE)!.rounds[0].decided).toBe('forfeit');
  });

  it('an abandon: told once, every stake back', async () => {
    const { a, b, sa, sb } = await table();
    const close = kit.close(AMY, 1, 'g', [sa, sb]);
    put(a, close);
    sync(a, b);
    const heard = step(a, b, () => put(a, kit.abandon(BOB, 1, close.hash)));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [100], bob: [100] });
  });

  it('a checkpoint and the next session in one transaction: told once, and no bal: listener', async () => {
    const { a, b, sa, sb } = await table();
    const close = kit.close(AMY, 1, 'g', [sa, sb]);
    put(a, close, kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    const next = kit.slip(BOB, 2, [black(4)]);
    put(a, next);
    sync(a, b);
    const cp: Checkpoint = kit.checkpoint(AMY, 'g', 1, close.hash, Object.fromEntries(a.casino.computedFoldOf(TABLE)!.nets));
    const map = a.doc.getMap('casinoComputed');
    const heard = step(a, b, () => a.doc.transact(() => {
      map.set(`sum:${TABLE}:${INC}`, cp);
      map.delete(`ses:${TABLE}:${INC}:g`);
      const ses = new Y.Map<unknown>();
      map.set(`ses:${TABLE}:${INC}:${kit.sidAfter(cp)}`, ses);
      ses.set(next.key, next.rec);
    }));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [], bob: [] });
    for (const page of [a, b]) expect(page.casino.readChips(BOB.pid)).toBe(97 - 4);
  });

  it('a switch written or deleted: told once (by the casino map), the felts held or handed back', async () => {
    const { a, b } = await table();
    let heard = step(a, b, () => a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [100], bob: [100] });
    heard = step(a, b, () => a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC }));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [98], bob: [97] });
  });

  it('a gone: mark: told once, the felts handed back', async () => {
    const { a, b } = await table();
    const heard = step(a, b, () => a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [100], bob: [100] });
  });

  it('a close and a casino key in one transaction: told once, the view key with the casino keys', async () => {
    const { a, b, sa, sb } = await table();
    let seats = 0;
    for (const page of [a, b]) page.casino.subscribeCasinoKey(`seat:${TABLE}:${AMY.pid}`, () => { seats += 1; });
    const heard = step(a, b, () => a.doc.transact(() => {
      a.doc.getMap('casino').set(`seat:${TABLE}:${AMY.pid}`, { stand: 0, angle: 0, at: 1 });
      put(a, kit.close(AMY, 1, 'g', [sa, sb]));
    }));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [], bob: [] });
    expect(seats).toBe(2);
  });

  it('records and a casino key in one transaction: told once, by the casino map', async () => {
    const { a, b, sa, sb } = await table();
    const heard = step(a, b, () => a.doc.transact(() => {
      a.doc.getMap('casino').set(`seat:${TABLE}:${AMY.pid}`, { stand: 0, angle: 0, at: 1 });
      put(a, kit.close(AMY, 1, 'g', [sa, sb]), kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    }));
    for (const h of heard) expect(h).toEqual({ all: 1, view: 1, amy: [170], bob: [97] });
  });

  it('records beside a chip record and a casino key: no notify past what PR 1 gives that transaction, bal: once', async () => {
    // (PR 1 tells subscribeCasino listeners once from each casino map a
    // transaction changes, and each bal: key once.)
    const pr1 = await table();
    const without = step(pr1.a, pr1.b, () => pr1.a.doc.transact(() => {
      pr1.a.casino.buyInChips(AMY.pid, 5);
      pr1.a.doc.getMap('casino').set(`seat:${TABLE}:${AMY.pid}`, { stand: 0, angle: 0, at: 1 });
    }));
    const { a, b, sa, sb } = await table();
    const heard = step(a, b, () => a.doc.transact(() => {
      a.casino.buyInChips(AMY.pid, 5);
      a.doc.getMap('casino').set(`seat:${TABLE}:${AMY.pid}`, { stand: 0, angle: 0, at: 1 });
      put(a, kit.close(AMY, 1, 'g', [sa, sb]), kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid));
    }));
    for (const [i, h] of heard.entries()) {
      expect(h).toEqual({ all: without[i].all, view: 1, amy: [105 + 70], bob: [97] });
      expect(without[i]).toMatchObject({ view: 0, amy: [98 + 5], bob: [] });
    }
  });

  it('a transaction that changes nothing a computed table counts tells no one', async () => {
    const { a, b } = await table();
    const heard = step(a, b, () => a.doc.getMap('elsewhere').set('x', 1));
    for (const h of heard) expect(h).toEqual({ all: 0, view: 0, amy: [], bob: [] });
  });

  it('the same records put again tell no one: the fold read nothing new', async () => {
    const { a, b, sa, sb } = await table();
    const heard = step(a, b, () => put(a, sa, sb));
    for (const h of heard) expect(h).toEqual({ all: 0, view: 0, amy: [], bob: [] });
  });
});

describe('records beside a PR 1 settle that moves no chip', () => {
  // A roulette settle writes its book into casinoChips, then the table into
  // the casino map. With nobody betting the book moves no chip, and PR 1
  // tells that transaction once, from the casino map; a computed record in
  // the same transaction, or in the same resync diff, adds no notify to it.
  const LEGACY = 'roulette-9';
  type Dealer = Page & { croupier: typeof import('./croupier') };

  /** A page and the croupier of its own load of the modules. */
  async function dealer(clientID: number): Promise<Dealer> {
    const page = await loadPage(clientID);
    return { ...page, croupier: await import('./croupier') };
  }

  function spinTo(pocket: number): void {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      (arr as unknown as Uint32Array)[0] = pocket;
      return arr;
    });
  }

  /** Two pages, Amy with 100 chips and her key pinned, the computed table
   *  switched on, and a PR 1 table's betting closed with nobody on it. */
  async function idleLegacy(): Promise<{ a: Dealer; b: Dealer }> {
    const a = await dealer(1);
    const b = await dealer(2);
    a.casino.buyInChips(AMY.pid, 100);
    pin(a, AMY);
    switchOn(a);
    a.casino.writeCrapsFairnessPref(LEGACY, 'rng');
    a.croupier.openBetting(LEGACY, 1);
    a.croupier.closeBetting(LEGACY, a.casino.readTableState(LEGACY)!);
    sync(a, b);
    return { a, b };
  }

  it('in one transaction on the writing page: told once, as the settle alone is', async () => {
    const pr1 = await idleLegacy();
    const alone = listen(pr1.a);
    spinTo(3);
    pr1.a.casino.transactCasino(() => pr1.a.croupier.rollAndSettle(LEGACY, 1));
    await flush();
    vi.restoreAllMocks();
    expect(pr1.a.casino.readTableState(LEGACY)).toMatchObject({ phase: 'settled', round: 1 });
    expect(alone).toEqual({ all: 1, view: 0, amy: [], bob: [] });

    const { a } = await idleLegacy();
    const slip = kit.slip(AMY, 1, [red(10)]);
    const heard = listen(a);
    spinTo(3);
    a.casino.transactCasino(() => {
      a.croupier.rollAndSettle(LEGACY, 1);
      put(a, slip);
    });
    await flush();
    expect(a.casino.readTableState(LEGACY)).toMatchObject({ phase: 'settled', round: 1 });
    expect(heard).toEqual({ all: 1, view: 1, amy: [90], bob: [] });
  });

  it('in one resync diff on a page that hears it: told once, as the settle alone is', async () => {
    const heardWith = async (slip: boolean): Promise<{ heard: Heard; tables: number }> => {
      const { a, b } = await idleLegacy();
      // Page b misses page a's settle, and Amy's slip after it, then gets
      // both in one diff.
      spinTo(3);
      a.croupier.rollAndSettle(LEGACY, 1);
      await flush();
      vi.restoreAllMocks();
      if (slip) put(a, kit.slip(AMY, 1, [red(10)]));
      const heard = listen(b);
      let tables = 0;
      b.casino.subscribeCasinoKey(`table:${LEGACY}`, () => { tables += 1; });
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
      expect(b.casino.readTableState(LEGACY)).toMatchObject({ phase: 'settled', round: 1 });
      return { heard, tables };
    };
    expect(await heardWith(false)).toEqual({ heard: { all: 1, view: 0, amy: [], bob: [] }, tables: 1 });
    expect(await heardWith(true)).toEqual({ heard: { all: 1, view: 1, amy: [90], bob: [] }, tables: 1 });
  });
});

describe('a verification slice', () => {
  /** Round 1 on both pages; then new versions of both felts and a close of
   *  them, three signatures for page b to check. */
  async function threeToCheck(): Promise<{ a: Page; b: Page; write: () => void }> {
    const { a, b } = await table();
    const va = kit.slip(AMY, 1, [...amyBets, red(10)], { v: 2 });
    const vb = kit.slip(BOB, 1, [...bobBets, black(20)], { v: 2 });
    return { a, b, write: () => put(a, va, vb, kit.close(BOB, 1, 'g', [va, vb])) };
  }

  it('the checks past the budget run in an empty transaction after, told once, and nothing goes to the room', async () => {
    const { a, b, write } = await threeToCheck();
    let clock = 0;
    // Each check takes 25 ms of a 40 ms budget: two a pass.
    b.casino.setComputedVerifyForTests({ now: () => (clock += 25) });
    const heard = listen(b);
    write();
    sync(a, b);
    expect(heard.all).toBe(1); // a transaction of casinoComputed alone: told once
    expect(b.casino.computedFoldOf(TABLE)!.pending).toBe(true);
    expect(b.casino.computedSettled()).toBe(false);
    expect(b.casino.spendChips(AMY.pid, 1)).toBe(false);
    const sent: Uint8Array[] = [];
    b.doc.on('update', (u: Uint8Array) => sent.push(u));
    await flush();
    const res = b.casino.computedFoldOf(TABLE)!;
    expect(res.pending).toBe(false);
    expect(res.tip?.present).toEqual([AMY.pid, BOB.pid]);
    expect(b.casino.computedSettled()).toBe(true);
    expect(b.casino.readChips(AMY.pid)).toBe(100 - 12);
    expect(b.casino.readChips(BOB.pid)).toBe(100 - 23);
    expect(heard.all).toBe(2); // the slice: told once more
    expect(heard.view).toBe(2);
    expect(heard.bob.at(-1)).toBe(77);
    expect(sent).toEqual([]); // the slice sent nothing to the room
  });

  it('with the real budget clock, a check slower than the budget still lands, one a pass', async () => {
    const { a, b, write } = await threeToCheck();
    const real = (await import('./keypair')).verifyIdentityStrict;
    let checks = 0;
    b.casino.setComputedVerifyForTests({
      verify: (pub, bytes, sig) => {
        checks += 1;
        const until = performance.now() + 45;
        while (performance.now() < until) { /* a slow page */ }
        return real(pub, bytes, sig);
      },
    });
    const heard = listen(b);
    write();
    sync(a, b);
    expect(checks).toBe(1);
    await flush();
    expect(checks).toBe(3);
    expect(b.casino.computedFoldOf(TABLE)!.pending).toBe(false);
    expect(b.casino.readChips(BOB.pid)).toBe(77);
    expect(heard.all).toBe(3); // the transaction, and one slice a check after the first
  });
});

describe('notifyCasinoView', () => {
  it("tells every listener and the table's view key, and no bal: key", async () => {
    const { a } = await table();
    const heard = listen(a);
    let other = 0;
    a.casino.subscribeCasinoKey('computed:roulette-2', () => { other += 1; });
    a.casino.notifyCasinoView(TABLE);
    expect(heard).toEqual({ all: 1, view: 1, amy: [], bob: [] });
    expect(other).toBe(0);
  });
});
