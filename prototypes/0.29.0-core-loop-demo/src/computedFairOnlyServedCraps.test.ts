/**
 * 🔒🎲🏠 A FAIR ONLY craps game the table has left is served (design §8.4, PR 6c-4b-1b), as a roulette one is
 * (computedFairOnlyServed.test.ts): the roll whose bets are down is closed while the house is heard, and the seeds go
 * in, each by the game's own session and fold, whichever of the two the table plays.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id and identity key (computedPageKit),
 * synced by hand, every clock explicit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc } from './computedFairOnly';
import { nextSid3 } from './computedFold';
import type { FoldCtx } from './computedFold';
import { delegation, house as H, NAME, owner, rootOf } from './computedFairOnlyKit';
import { Beating, clockOf, CRAPS_REF, CRAPS_TABLE as TABLE, crapsBet, keysIn, loadPage, PAGE_ROOM, putIn, run as runBare, standAt, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit } from './computedTestKit';

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

/** A craps game of the owner's at the table, the house H; and a second game of theirs (another name), the craps one's
 *  twin or a roulette game (a `p` name sorts before a `q`: S9 plays it when the switch names it, and a craps table
 *  runs nothing of it). */
const Q = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('q', PAGE_ROOM, TABLE, NAME) };
const root = rootOf(Q, 'q', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID = nextSid3(Q, root.value);
const kit = new ComputedKit(Q);
const NAME2 = { ...NAME, j: 'fedcba9876543210' };
const second = (letter: 'p' | 'q') => {
  const ctx: FoldCtx = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc(letter, PAGE_ROOM, TABLE, NAME2) };
  const rootB = rootOf(ctx, letter, { j: NAME2.j, dl: delegation(owner, H.pub, PAGE_ROOM) });
  return { ctx, rootB, sid: nextSid3(ctx, rootB.value) };
};

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const casinoOf = (p: Page) => p.doc.getMap<unknown>('casino');
/** The records of kind `kind` (s, c, x, f, z) and roll r in game `inc`'s session, whichever game the table plays. */
function inSession(p: Page, inc: string, kind: string, r: number): string[] {
  const key = [...top(p).keys()].find((k) => k.startsWith(`ses:${TABLE}:${inc}:`));
  const ses = key === undefined ? undefined : (top(p).get(key) as Y.Map<unknown>);
  return ses === undefined ? [] : [...ses.keys()].filter((k) => k.startsWith(`${kind}:${r}:`)).sort();
}
const nameGame = (a: Page, inc: string): void => {
  a.doc.transact(() => {
    casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc });
  });
};

/** The house of both games beats while a spec runs (Beating, in page a's doc), or not. */
let beat: Beating | null = null;
const run = (pages: Page[], from: number, to: number, opts: Parameters<typeof runBare>[3] = {}): number =>
  runBare(pages, from, to, { each: beat?.each, tables: [CRAPS_REF], ...opts });

/** Page A at stand 1 with 1,000 chips, both games open in its doc (the first with the house joined, a pass bet down
 *  on it), the table playing the first, the house beating, all synced at T0. */
async function twoGames(letter: 'p' | 'q' = 'q'): Promise<{ a: Page; other: string }> {
  const a = await loadPage('A', 1);
  clockOf(a, T0);
  a.casino.buyInChips(a.pid, 1_000);
  standAt(a, 1);
  const twin = second(letter);
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(`ses:${TABLE}:${Q.inc}:${SID}`, new Y.Map());
    top(a).set(twin.rootB.key, twin.rootB.value);
    top(a).set(`ses:${TABLE}:${twin.ctx.inc}:${twin.sid}`, new Y.Map());
  });
  nameGame(a, Q.inc);
  const join = kit.houseJoin(H, 1);
  putIn(a, [[join.key, join.rec]], TABLE);
  beat = new Beating(a, H);
  sync(T0, a);
  run([a], T0, T0, { step: STEP }); // (awake)
  expect(a.casino.computedIncOf(TABLE)).toBe(Q.inc);
  expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
  return { a, other: twin.ctx.inc };
}

describe('a craps game the table has left', () => {
  it('has its roll closed while the house is heard, the table playing the other game, and the seed revealed after it', async () => {
    const { a, other } = await twoGames();
    nameGame(a, other);
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    const closedAt = run([a], T0 + STEP, T0 + 60_000, { step: STEP, until: () => inSession(a, Q.inc, 'c', 1).length > 0 });
    expect(inSession(a, Q.inc, 'c', 1)).toHaveLength(1);
    run([a], closedAt + STEP, closedAt + 3_000, { step: STEP });
    expect(inSession(a, Q.inc, 'x', 1)).toHaveLength(1);
    // (the game played got nothing)
    for (const kind of ['s', 'c', 'x']) expect(keysIn(a, kind, undefined, TABLE)).toEqual([]);
  });

  it('closes nothing while its house is not heard, and its roll is closed when the house beats again', async () => {
    const { a, other } = await twoGames();
    beat!.muted = true;
    nameGame(a, other);
    const quiet = run([a], T0 + STEP, T0 + 60_000, { step: STEP });
    expect(inSession(a, Q.inc, 'c', 1)).toEqual([]);
    beat!.muted = false;
    const closedAt = run([a], quiet, quiet + 10_000, { step: STEP, until: () => inSession(a, Q.inc, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + STEP * 2);
  });

  it('starts nothing new for the player: a stand taken once the table has left the game is not written into its bet, and goes once the table plays it again', async () => {
    const { a, other } = await twoGames();
    nameGame(a, other);
    // (a stand taken a while after the bet, past the coalescing of a player's writes: a version that carries it would go at once)
    const mid = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    standAt(a, 2);
    const late = run([a], mid + STEP, mid + 3_000, { step: STEP });
    expect(inSession(a, Q.inc, 's', 1)).toHaveLength(1);
    nameGame(a, Q.inc);
    run([a], late + STEP, late + 3_000, { step: STEP });
    expect(inSession(a, Q.inc, 's', 1)).toHaveLength(2);
  });

  it('is served when the game the table plays is a roulette one, which a craps table runs nothing of', async () => {
    const { a, other } = await twoGames('p');
    nameGame(a, other);
    expect(a.casino.computedIncOf(TABLE)).toBe(other);
    expect(a.casino.computedResolutionOf(TABLE, other)).toMatchObject({ live: true, letter: 'p' });
    const closedAt = run([a], T0 + STEP, T0 + 60_000, { step: STEP, until: () => inSession(a, Q.inc, 'c', 1).length > 0 });
    expect(inSession(a, Q.inc, 'c', 1)).toHaveLength(1);
    run([a], closedAt + STEP, closedAt + 3_000, { step: STEP });
    expect(inSession(a, Q.inc, 'x', 1)).toHaveLength(1);
  });
});
