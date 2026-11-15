/**
 * 🔒🪧 What a FAIR ONLY table shows (design §8.3 "Display at p/q", §8.4 "The
 * paused felt"; PR 6c-4c): the page's reader of the game (computedTable
 * computedFairOnlyView) and the words made from it (computedFairOnlyLines).
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id
 * and identity key (computedPageKit), synced by hand, every clock explicit. The
 * game is written into the first page's doc as its owner's page would write it;
 * the house is a TestHouse whose records and heartbeats a spec writes by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, sealFin } from './computedFairOnly';
import { nextSid3 } from './computedFold';
import { buyer, delegation, hex, house as H, NAME, owner, rootOf, trimOf, xferOf } from './computedFairOnlyKit';
import { Beating, clockOf, keysIn, loadPage, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run as runBare, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red } from './computedTestKit';
import { HOUSE_HEARD_MS } from './computedHouse';
import {
  FAIR_ONLY_SETTING, FAIR_ONLY_UPDATE, FAIR_ONLY_WAITS, fairOnlyBadge, fairOnlyCardLines, fairOnlyClosedLine, fairOnlyFeltLine,
} from './computedFairOnlyLines';
import type { ComputedFairOnlyView } from './computedTable';

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

const G = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(G, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID = nextSid3(G, root.value);
const kit = new ComputedKit(G);
const DEED = { kind: 'deed' as const, roomId: PAGE_ROOM, roomName: 'Furlong' };
const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const viewOf = (p: Page, T: number) => p.table.computedFairOnlyView(TABLE, clockOf(p, T));

let beating: Beating[] = [];
const run = (pages: Page[], from: number, to: number, opts: Parameters<typeof runBare>[3] = {}): number =>
  runBare(pages, from, to, { each: (T) => beating.forEach((b) => b.each(T)), ...opts });

/** Pages `names`, 1,000 chips each, and the game open in the first page's doc, all synced at T0. */
async function gameRoom(names: string[], recs: { key: string; value: unknown }[] = [root], sid = SID, inc = G.inc): Promise<Page[]> {
  beating = [];
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  const [a] = pages;
  a.doc.transact(() => {
    for (const r of recs) top(a).set(r.key, r.value);
    top(a).set(`ses:${TABLE}:${inc}:${sid}`, new Y.Map());
  });
  sync(T0, ...pages);
  runBare(pages, T0, T0, { step: STEP }); // (awake)
  return pages;
}

/** Player `who` shows its key in page p's room, and the room names `holder` its owner. */
function pin(p: Page, who: typeof owner, holder?: typeof owner): void {
  p.doc.transact(() => p.doc.getMap('players').set(who.pid, { keyB64: who.pub, name: who.pid }));
  if (holder) p.doc.transact(() => p.doc.getMap('roomInfo').set('owner', holder.pid));
}

/** A view as the reader gives one of a game that plays, `patch` laid over it. */
const view = (patch: Partial<ComputedFairOnlyView> = {}): ComputedFairOnlyView => ({
  inc: G.inc, game: 'roulette', newer: false, checking: false, holder: owner.pub, holderPid: owner.pid, mine: false, ended: false, waits: null, waiting: null,
  heard: true, round: 0, o: null, moved: false, ...patch,
});
const texts = (v: ComputedFairOnlyView, game: 'craps' | 'roulette' = 'roulette', riders = 0, names: { holder: string | null; deed: string | null } = { holder: 'OLA', deed: null }) =>
  fairOnlyCardLines(v, game, names, riders).map((l) => l.text);

describe('the words of a FAIR ONLY table (computedFairOnlyLines)', () => {
  it('the plaque never reads Friendly: Fair while rounds close, the wait while they do not, the end, and the update for rules this build does not know', () => {
    expect(fairOnlyBadge(view())).toEqual({ text: '✔ FAIR ONLY · THE HOUSE AND EVERY BETTOR ADD A SEED', color: '#7CF5B0', fair: true });
    for (const waits of ['house', 'full'] as const) expect(fairOnlyBadge(view({ waits }))).toMatchObject({ text: FAIR_ONLY_SETTING, fair: true });
    expect(fairOnlyBadge(view({ waits: 'ending' }))).toMatchObject({ text: 'FAIR ONLY · THIS GAME IS ENDING', fair: true });
    expect(fairOnlyBadge(view({ ended: true }))).toMatchObject({ text: 'FAIR ONLY · THIS GAME HAS ENDED', fair: true });
    expect(fairOnlyBadge(view({ newer: true, ended: true, waits: 'house' }))).toMatchObject({ text: FAIR_ONLY_UPDATE, fair: false });
  });

  it('the paused felt says the table waits for the house and the bets stay; an ending game says no new round starts; a table that plays says nothing of its own', () => {
    expect(fairOnlyFeltLine(view(), 'roulette')).toBeNull();
    expect(FAIR_ONLY_WAITS).toBe('THE TABLE WAITS FOR THE HOUSE · BETS STAY ON THE FELT');
    for (const waits of ['house', 'full'] as const) expect(fairOnlyFeltLine(view({ waits }), 'roulette')?.line).toBe(FAIR_ONLY_WAITS);
    expect(fairOnlyFeltLine(view({ waits: 'ending' }), 'roulette')?.line).toBe('THIS GAME IS ENDING · NO NEW ROUND STARTS');
    expect(fairOnlyFeltLine(view({ waits: 'ending' }), 'craps')?.line).toBe('THIS GAME IS ENDING · NO NEW ROLL STARTS');
    expect(fairOnlyFeltLine(view({ newer: true }), 'roulette')?.line).toBe(FAIR_ONLY_UPDATE);
  });

  it('a round closed and undecided waits for the house\'s seed, or goes void with the house away, and no Friendly round is promised after it', () => {
    expect(fairOnlyClosedLine(view(), 'roulette')).toBeNull();
    expect(fairOnlyClosedLine(view({ waiting: 'house' }), 'roulette')?.line).toBe("✋ NO MORE BETS — WAITING FOR THE HOUSE'S SEED");
    const away = fairOnlyClosedLine(view({ waiting: 'offline' }), 'craps')!.line;
    expect(away).toBe('⚠ THE HOUSE WENT OFFLINE · THIS ROLL GOES VOID UNLESS IT COMES BACK · THEN THE TABLE WAITS FOR IT');
    expect(away).not.toContain('FRIENDLY');
  });

  it('the card names whose game it is, how its house stands and the setting, in that order', () => {
    expect(texts(view())).toEqual(['THE HOUSE OF OLA', 'THE HOUSE IS ONLINE', `FAIRNESS · ${FAIR_ONLY_SETTING}`]);
    expect(texts(view({ waits: 'house' }))[1]).toBe(FAIR_ONLY_WAITS);
    expect(texts(view({ waits: 'full' }))[1]).toBe("THE TABLE WAITS FOR THE HOUSE'S CHECKPOINT · BETS STAY ON THE FELT");
    expect(texts(view({ waits: 'ending' }))[1]).toBe('THIS GAME IS ENDING · NO NEW ROUND STARTS');
    expect(texts(view({ waiting: 'offline' }))[1]).toBe('THE HOUSE IS NOT HEARD · THIS ROUND GOES VOID UNLESS IT COMES BACK');
    expect(texts(view({ ended: true, waits: 'house' }))[1]).toBe('THIS GAME HAS ENDED');
    // (rounds that close say nothing of the house: online only when the house the round depends on is heard)
    expect(texts(view({ heard: false }))[1]).toBe('THE HOUSE IS NOT HEARD');
    expect(texts(view({ heard: false, waiting: 'house' }))[1]).toBe('THE HOUSE IS NOT HEARD');
    // (a holder nobody can name yet gets no line of its own)
    expect(texts(view({ holder: null, holderPid: null }), 'roulette', 0, { holder: null, deed: null })).toEqual(['THE HOUSE IS ONLINE', `FAIRNESS · ${FAIR_ONLY_SETTING}`]);
  });

  it('a game the deed does not name says whose it is and whom the deed names; a game the table moved to is flagged', () => {
    expect(texts(view({ deedPid: 'p-bo' }), 'roulette', 0, { holder: 'OLA', deed: 'BO' })[0]).toBe("THIS GAME IS OLA'S · THE DEED NAMES BO");
    expect(texts(view({ deedPid: null }))[0]).toBe("THIS GAME IS OLA'S · THE DEED NAMES NOBODY");
    const moved = fairOnlyCardLines(view({ moved: true }), 'roulette', { holder: 'OLA', deed: null }, 0);
    expect(moved[1]).toEqual({ text: "🚩 THE TABLE'S GAME MOVED TO THE HOUSE OF OLA", color: '#FF8A80' });
    expect(texts(view()).some((t) => t.includes('MOVED'))).toBe(false);
  });

  it('riding bets wait for the owner\'s house only at craps, with riders, while the table waits for its house', () => {
    const RIDING = "RIDING BETS WAIT FOR THE OWNER'S HOUSE";
    expect(texts(view({ waits: 'house' }), 'craps', 2)).toContain(RIDING);
    expect(texts(view({ waits: 'full' }), 'craps', 1)).toContain(RIDING);
    expect(texts(view({ waits: 'house' }), 'craps', 0)).not.toContain(RIDING);
    expect(texts(view({ waits: 'house' }), 'roulette', 2)).not.toContain(RIDING);
    expect(texts(view(), 'craps', 2)).not.toContain(RIDING);
    expect(texts(view({ waits: 'ending' }), 'craps', 2)).not.toContain(RIDING);
  });

  it('the last round the house signed shows with its pocket or its dice, a check that waits says so, and unknown rules show nothing but the update', () => {
    expect(texts(view({ round: 7, o: 17 }))).toContain('ROUND 7 · POCKET 17 · SIGNED BY THE HOUSE');
    expect(texts(view({ round: 7, o: 0 }))).toContain('ROUND 7 · POCKET 0 · SIGNED BY THE HOUSE');
    expect(texts(view({ round: 4, o: [3, 4] }), 'craps')).toContain('ROLL 4 · DICE 3 AND 4 · SIGNED BY THE HOUSE');
    expect(texts(view({ round: 0, o: 17 })).some((t) => t.includes('SIGNED BY'))).toBe(false);
    expect(texts(view({ round: 7 })).some((t) => t.includes('SIGNED BY'))).toBe(false);
    expect(texts(view({ checking: true })).at(-1)).toBe("CHECKING THIS GAME'S RECORDS");
    expect(texts(view()).some((t) => t.includes('CHECKING'))).toBe(false);
    expect(texts(view({ newer: true, moved: true, checking: true, round: 7, o: 1 }))).toEqual([`${FAIR_ONLY_UPDATE} · ITS GAME USES RULES THIS VERSION DOES NOT KNOW`]);
  });
});

describe('what a page reads of the FAIR ONLY game its table plays (computedFairOnlyView)', () => {
  it('nothing at a table that plays no FAIR ONLY game; and at one, the house table\'s reader answers nothing: no setting runs it without its house', async () => {
    const [a] = await gameRoom(['A'], []);
    expect(viewOf(a, T0)).toBeNull();
    const [b] = await gameRoom(['B']);
    expect(viewOf(b, T0)).toMatchObject({ inc: G.inc, game: 'roulette', newer: false, ended: false, heard: false });
    expect(b.table.computedHouseState(TABLE, clockOf(b, T0))).toBeNull();
  });

  it('a name the switch carries with no game behind it is no FAIR ONLY table: nothing is read of it', async () => {
    const [a] = await gameRoom(['A'], []);
    a.doc.transact(() => a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: G.inc }));
    run([a], T0 + STEP, T0 + 3 * STEP, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
    expect(viewOf(a, T0 + 3 * STEP)).toBeNull();
  });

  it('checking, while a record of the game\'s session waits to be checked though the resolution is done', async () => {
    const [a] = await gameRoom(['A']);
    expect(viewOf(a, T0)!.checking).toBe(false);
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    putIn(a, [[kit.houseJoin(H, 1).key, kit.houseJoin(H, 1).rec]]);
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ pending: false });
    expect(a.casino.computedFoldOf(TABLE, G.inc)).toMatchObject({ pending: true });
    expect(viewOf(a, T0)!.checking).toBe(true);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    // (The slice that checks what waited runs off the frame.)
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const T = run([a], T0 + STEP, T0 + 3 * STEP, { step: STEP });
    expect(viewOf(a, T)!.checking).toBe(false);
  });

  it('whose game: the key that holds it, the player this page pinned to it once that player shows the key, and whether it is this page\'s', async () => {
    const [a] = await gameRoom(['A']);
    expect(viewOf(a, T0)).toMatchObject({ holder: owner.pub, holderPid: null, mine: false });
    pin(a, owner, owner);
    run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    const v = viewOf(a, T0 + 2 * STEP)!;
    expect(v).toMatchObject({ holder: owner.pub, holderPid: owner.pid, mine: false, moved: false, round: 0, o: null });
    expect('deedPid' in v).toBe(false);
  });

  it('the table waits while no house has joined, plays once a house that beats has, and waits again HOUSE_HEARD_MS after that house falls silent', async () => {
    const [a] = await gameRoom(['A']);
    expect(viewOf(a, T0)!.waits).toBe('house');
    putIn(a, [[kit.houseJoin(H, 1).key, kit.houseJoin(H, 1).rec]]);
    // (joined and never heard: only that house holds the seed behind the commitment)
    let T = run([a], T0 + STEP, T0 + 2_000, { step: STEP });
    expect(viewOf(a, T)!.waits).toBe('house');
    const beat = new Beating(a, H);
    beating = [beat];
    T = run([a], T, T + 2_000, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ waits: null, waiting: null, heard: true });
    beat.muted = true;
    const last = beat.lastAt!;
    T = run([a], T, last + HOUSE_HEARD_MS - STEP, { step: STEP });
    expect(viewOf(a, T)!.waits).toBeNull();
    T = run([a], T, last + HOUSE_HEARD_MS + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ waits: 'house', heard: false });
  });

  it('a round closed waits on its house: for its seed once the bettors\' are in, and offline once the house is not heard', async () => {
    const [a, b] = await gameRoom(['A', 'B']);
    putIn(a, [[kit.houseJoin(H, 1).key, kit.houseJoin(H, 1).rec]]);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, a, b);
    const beat = new Beating(a, H);
    beating = [beat];
    let T = run([a, b], T0 + STEP, T0 + 120_000, { step: STEP, until: () => keysIn(a, 'c', 1).length > 0 });
    expect(keysIn(a, 'c', 1).length).toBe(1);
    T = run([a, b], T, T + 10_000, { step: STEP, until: () => a.table.computedFairOnlyView(TABLE)!.waiting === 'house' });
    expect(viewOf(a, T)).toMatchObject({ waits: null, waiting: 'house', heard: true });
    beat.muted = true;
    T = run([a, b], T, beat.lastAt! + HOUSE_HEARD_MS + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ waits: null, waiting: 'offline', heard: false });
  });

  it('an end order makes the game ending, and its end makes it ended while the switch still names it', async () => {
    const [a] = await gameRoom(['A']);
    const fin = sealFin(G, owner.pub, owner.sign);
    a.doc.transact(() => top(a).set(fin.key, fin.value));
    let T = run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ waits: 'ending', ended: false });
    const end = trimOf(G, 'p', { u: 5, l: hex('e', 32), n: {}, e: 1, f: fin.value, s: undefined, h: undefined, k: owner.pub, dl: undefined, o: 17 });
    a.doc.transact(() => {
      top(a).set(end.key, end.value);
      a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: G.inc });
    });
    T = run([a], T + STEP, T + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ inc: G.inc, ended: true, waits: null, round: 5, o: 17 });
  });

  it('a game the deed does not name: after a hand-over of the game the room still names the seller, until it names the buyer', async () => {
    const [a] = await gameRoom(['A']);
    pin(a, owner, owner);
    pin(a, buyer);
    const xf = xferOf(G, owner, buyer, 0, { asset: DEED });
    a.doc.transact(() => top(a).set(xf.key, xf.value));
    let T = run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ holder: buyer.pub, holderPid: buyer.pid, deedPid: owner.pid });
    // (no house of the buyer's has joined, and none is heard: whatever closes, the house does not read as online)
    expect(viewOf(a, T)!.heard).toBe(false);
    expect(fairOnlyCardLines(viewOf(a, T)!, 'roulette', { holder: 'B', deed: 'O' }, 0).map((l) => l.text)).not.toContain('THE HOUSE IS ONLINE');
    pin(a, buyer, buyer);
    T = run([a], T + STEP, T + 2 * STEP, { step: STEP });
    expect('deedPid' in viewOf(a, T)!).toBe(false);
    // (a room that names nobody: the deed names nobody)
    a.doc.transact(() => a.doc.getMap('roomInfo').delete('owner'));
    T = run([a], T + STEP, T + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ holder: buyer.pub, deedPid: null });
  });

  it('a game whose rules this build does not know reads as newer, and nothing else of it is shown', async () => {
    const name = { ...NAME, rv: 'zz' };
    const ctx = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, name) };
    const theirs = rootOf(ctx, 'p', { rv: 'zz', dl: delegation(owner, H.pub, PAGE_ROOM) });
    const [a] = await gameRoom(['A'], [theirs], nextSid3(ctx, theirs.value), ctx.inc);
    a.doc.transact(() => a.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: ctx.inc }));
    const T = run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ inc: ctx.inc, newer: true, waits: null, ended: false });
    expect(fairOnlyBadge(viewOf(a, T)!).text).toBe(FAIR_ONLY_UPDATE);
  });

  it('the table\'s view is told when a transfer moves the holder: every resolution of a game has the fold answer anew', async () => {
    const [a] = await gameRoom(['A']);
    run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    let told = 0;
    a.casino.subscribeCasinoKey(`computed:${TABLE}`, () => { told += 1; });
    const xf = xferOf(G, owner, buyer, 0, { asset: DEED });
    a.doc.transact(() => top(a).set(xf.key, xf.value));
    run([a], T0 + 3 * STEP, T0 + 4 * STEP, { step: STEP });
    expect(viewOf(a, T0 + 4 * STEP)!.holder).toBe(buyer.pub);
    expect(told).toBeGreaterThan(0);
  });

  it('a table whose game ended while another of its games is live moved to that one, and says so of it', async () => {
    const other = { ...NAME, j: 'fedcba9876543210' };
    const ctx2 = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, other) };
    const root2 = rootOf(ctx2, 'p', { j: other.j, dl: delegation(owner, H.pub, PAGE_ROOM) });
    const [a] = await gameRoom(['A']);
    a.doc.transact(() => {
      top(a).set(root2.key, root2.value);
      top(a).set(`ses:${TABLE}:${ctx2.inc}:${nextSid3(ctx2, root2.value)}`, new Y.Map());
    });
    let T = run([a], T0 + STEP, T0 + 2 * STEP, { step: STEP });
    const played = viewOf(a, T)!;
    expect(played.moved).toBe(false);
    const [P, patch, next] = played.inc === G.inc ? [G, {}, ctx2.inc] : [ctx2, { j: other.j }, G.inc];
    const end = trimOf(P, 'p', { ...patch, u: 5, l: hex('e', 32), n: {}, e: 1, f: sealFin(P, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined });
    a.doc.transact(() => top(a).set(end.key, end.value));
    T = run([a], T + STEP, T + 2 * STEP, { step: STEP });
    expect(viewOf(a, T)).toMatchObject({ inc: next, moved: true, ended: false });
  });
});
