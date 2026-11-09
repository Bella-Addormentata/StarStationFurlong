/**
 * 🔒🏠 A FAIR ONLY game the table has left is served (design §8.4, PR 6c-4b-1b). The table plays one of the games
 * live at it (S9), and a page goes on with its duties in the others it has played: the seed it holds for a slip a
 * close froze is revealed, a round whose window ran out is closed while the house is heard, an abandon voids a round
 * the house left, a record the doc lost is put back. Each by the game's own session and fold, whatever the table
 * plays. Not what would start something new for the player: no felt held back goes.
 *
 * Each page is its own load of the casino modules with its own Y.Doc, player id and identity key (computedPageKit),
 * synced by hand, every clock explicit. Two games of the owner's are written into the first page's doc, the table's
 * switch (the deed's choice) names the one played, and the house of both is a TestHouse whose records and heartbeats
 * a spec writes by hand.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { faironlyInc, sealFin } from './computedFairOnly';
import { asAbandon, asReveal, nextSid3 } from './computedFold';
import type { FoldCtx } from './computedFold';
import { delegation, hex, house as H, NAME, owner, rootOf, trimOf } from './computedFairOnlyKit';
import { Beating, clockOf, frame, keysIn, loadPage, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run as runBare, sync } from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red } from './computedTestKit';
import type { Built } from './computedTestKit';
import { HOUSE_HEARD_MS } from './computedHouse';

vi.stubGlobal('window', { location: { search: '' } });

/** The times S9 (tableGame) was asked, over every load of the modules: a spec counts the looks a step makes. */
const asked = vi.hoisted(() => ({ tableGame: 0 }));
vi.mock('./computedFairOnlyAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./computedFairOnlyAuth')>();
  return { ...real, tableGame: (...args: Parameters<typeof real.tableGame>) => { asked.tableGame += 1; return real.tableGame(...args); } };
});

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
const root = rootOf(G, 'p', { dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID = nextSid3(G, root.value);
const kit = new ComputedKit(G);
/** A second game of the owner's at the table (another name), its root and its empty session. */
const NAME2 = { ...NAME, j: 'fedcba9876543210' };
const G2: FoldCtx = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAME2) };
const root2 = rootOf(G2, 'p', { j: NAME2.j, dl: delegation(owner, H.pub, PAGE_ROOM) });
const SID2 = nextSid3(G2, root2.value);

const top = (p: Page) => p.doc.getMap<unknown>('casinoComputed');
const casinoOf = (p: Page) => p.doc.getMap<unknown>('casino');
/** The records of kind `kind` (s, c, x, f, z) and round r in game `inc`'s session, whichever game the table plays. */
function inSession(p: Page, inc: string, kind: string, r: number): string[] {
  const key = [...top(p).keys()].find((k) => k.startsWith(`ses:${TABLE}:${inc}:`));
  const ses = key === undefined ? undefined : (top(p).get(key) as Y.Map<unknown>);
  return ses === undefined ? [] : [...ses.keys()].filter((k) => k.startsWith(`${kind}:${r}:`)).sort();
}
const recIn = (p: Page, inc: string, key: string): unknown => {
  const sesKey = [...top(p).keys()].find((k) => k.startsWith(`ses:${TABLE}:${inc}:`))!;
  return (top(p).get(sesKey) as Y.Map<unknown>).get(key);
};
/** The house's records put in the live session of the game the table plays on page p. */
const house = (p: Page, ...recs: Built<unknown>[]): void => putIn(p, recs.map((r) => [r.key, r.rec]));
/** The switch (the deed's choice, with no live game the deed holder's) names `inc`: the game the table plays. */
const nameGame = (a: Page, inc: string): void => {
  a.doc.transact(() => {
    casinoOf(a).set(`cfg:computed:${TABLE}`, { v: 1, inc });
  });
};

/** The house of both games beats while a spec runs (Beating, in page a's doc), or not. */
let beat: Beating | null = null;
const run = (pages: Page[], from: number, to: number, opts: Parameters<typeof runBare>[3] = {}): number =>
  runBare(pages, from, to, { each: beat?.each, ...opts });

/** Pages `names`, 1,000 chips each, the games G and G2 open in the first page's doc (G with its house joined), the table
 *  playing G, the house beating, all synced at T0. */
async function twoGames(names: string[] = ['A']): Promise<Page[]> {
  beat = null;
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1));
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  const [a] = pages;
  a.doc.transact(() => {
    top(a).set(root.key, root.value);
    top(a).set(`ses:${TABLE}:${G.inc}:${SID}`, new Y.Map());
    top(a).set(root2.key, root2.value);
    top(a).set(`ses:${TABLE}:${G2.inc}:${SID2}`, new Y.Map());
  });
  nameGame(a, G.inc);
  house(a, kit.houseJoin(H, 1));
  beat = new Beating(a, H);
  sync(T0, ...pages);
  run(pages, T0, T0, { step: STEP }); // (awake)
  expect(a.casino.computedIncOf(TABLE)).toBe(G.inc);
  return pages;
}

describe('a game the table has left', () => {
  it('has its open round closed when its window runs out and the house is heard, as the page would at the table, and the seed revealed after it', async () => {
    const [a] = await twoGames();
    const window = a.table.BET_WINDOW_MS;
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    expect(a.casino.computedIncOf(TABLE)).toBe(G2.inc);
    const closedAt = run([a], at + STEP, at + 40_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    expect(inSession(a, G.inc, 'c', 1)).toHaveLength(1);
    // (at its deadline, the betting window of the round it opened with)
    expect(closedAt).toBeGreaterThanOrEqual(at + window - STEP * 2);
    expect(closedAt).toBeLessThanOrEqual(at + window + STEP * 4);
    run([a], closedAt + STEP, closedAt + 2_000, { step: STEP });
    const [x] = inSession(a, G.inc, 'x', 1);
    expect(asReveal(recIn(a, G.inc, x))).toMatchObject({ r: 1, p: a.pid });
    // (the game played got nothing: the table plays G2, whose session holds no record of the page's)
    for (const kind of ['s', 'c', 'x', 'z']) expect(keysIn(a, kind)).toEqual([]);
    // (the page's own close is known good in the game it was written in, and in no other: nobody checks the signature of a record it signed)
    const [close] = inSession(a, G.inc, 'c', 1);
    const hash = close.slice(close.lastIndexOf(':') + 1);
    expect(a.casino.computedVerdictOf(TABLE, G.inc, hash)).toBe(true);
    expect(a.casino.computedVerdictOf(TABLE, G2.inc, hash)).toBeUndefined();
  });

  it('closes nothing while its house is not heard, and its round is closed when the house beats again', async () => {
    const [a] = await twoGames();
    const window = a.table.BET_WINDOW_MS;
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    beat!.muted = true;
    nameGame(a, G2.inc);
    const quiet = run([a], at + STEP, T0 + window + 40_000, { step: STEP });
    expect(inSession(a, G.inc, 'c', 1)).toEqual([]);
    beat!.muted = false;
    const closedAt = run([a], quiet, quiet + 10_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + STEP * 2);
  });

  it('has a round the house left voided by an abandon of the bettor\'s page once the house has been silent for HOUSE_HEARD_MS', async () => {
    const [a] = await twoGames();
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    const closedAt = run([a], at + STEP, at + 40_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    beat!.muted = true; // (the house never reveals, and is not heard again)
    const voidAt = run([a], closedAt + STEP, closedAt + 60_000, { step: STEP, until: () => inSession(a, G.inc, 'z', 1).length > 0 });
    expect(voidAt).toBeGreaterThanOrEqual(closedAt + HOUSE_HEARD_MS);
    expect(voidAt).toBeLessThanOrEqual(closedAt + HOUSE_HEARD_MS + STEP * 2);
    const [z] = inSession(a, G.inc, 'z', 1);
    expect(asAbandon(recIn(a, G.inc, z))).toMatchObject({ r: 1, k: a.pub });
    // back at the game: its round reads void
    nameGame(a, G.inc);
    run([a], voidAt + STEP, voidAt + 3_000, { step: STEP });
    expect(a.casino.computedFoldOf(TABLE)!.rounds[0]).toMatchObject({ r: 1, decided: 'void' });
  });

  it('is served only while the page looks at its table: a table out of the room\'s list has its left game waited on', async () => {
    const [a] = await twoGames();
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    const quiet = run([a], at + STEP, at + 40_000, { step: STEP, tables: [] });
    expect(inSession(a, G.inc, 'c', 1)).toEqual([]);
    const closedAt = run([a], quiet, quiet + 10_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + STEP * 2);
  });

  it('is served only as the game of the table it is at: a table the room lists as the other game has its left game waited on', async () => {
    const [a] = await twoGames();
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    // (the table is a craps one in the room's list for a while, as another table of the same name would be: a roulette game is none of its)
    const quiet = run([a], at + STEP, at + 25_000, { step: STEP, tables: [{ id: TABLE, game: 'craps' }] });
    expect(inSession(a, G.inc, 'c', 1)).toEqual([]);
    const closedAt = run([a], quiet, quiet + 10_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    expect(closedAt).toBeLessThanOrEqual(quiet + STEP * 2);
  });

  it('has a record of the page\'s the doc lost put back', async () => {
    const [a] = await twoGames();
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    run([a], at + STEP, at + 1_000, { step: STEP });
    const [s] = inSession(a, G.inc, 's', 1);
    const sesKey = [...top(a).keys()].find((k) => k.startsWith(`ses:${TABLE}:${G.inc}:`))!;
    const value = (top(a).get(sesKey) as Y.Map<unknown>).get(s);
    a.doc.transact(() => (top(a).get(sesKey) as Y.Map<unknown>).delete(s));
    expect(inSession(a, G.inc, 's', 1)).toEqual([]);
    beat!.muted = true; // (a close would freeze the slip: it is put back on its own account)
    run([a], at + 1_000 + STEP, at + 8_000, { step: STEP });
    expect(inSession(a, G.inc, 's', 1)).toEqual([s]);
    expect(recIn(a, G.inc, s)).toEqual(value);
  });

  it('starts nothing new for the player: a felt held back is not written while the game is left, and goes once the table plays it again', async () => {
    const [a] = await twoGames();
    beat!.muted = true; // (no close: only the felt is looked at)
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    expect(a.table.writeComputedSlip(TABLE, [red(9), black(5)], at + 100)).toBe('ok'); // (inside COALESCE_MS: held back)
    expect(inSession(a, G.inc, 's', 1)).toHaveLength(1);
    nameGame(a, G2.inc);
    const mid = run([a], at + 200, at + 5_000, { step: STEP });
    expect(inSession(a, G.inc, 's', 1)).toHaveLength(1);
    nameGame(a, G.inc);
    run([a], mid + STEP, mid + 3_000, { step: STEP });
    expect(inSession(a, G.inc, 's', 1)).toHaveLength(2);
  });

  it('serves only the games this page played: a page bound while another is played has no state for it, and its seed waits for the table', async () => {
    const [a] = await twoGames();
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    // the room's doc bound again while the table plays the other game: the page has played neither in this binding
    const snap = Y.encodeStateAsUpdate(a.doc);
    const doc2 = new Y.Doc();
    doc2.clientID = 77;
    Y.applyUpdate(doc2, snap);
    a.casino.setComputedVerifyForTests({ now: () => 0 });
    a.casino.bindCasinoDoc(doc2, PAGE_ROOM);
    a.doc = doc2;
    run([a], at + 1_000, at + 60_000, { step: STEP });
    expect(inSession(a, G.inc, 'c', 1)).toEqual([]);
    expect(inSession(a, G.inc, 'x', 1)).toEqual([]);
  });
});

/** Page A, and the other tab of its player (loaded afresh: the same key, but it wrote nothing, and keeps no copy and no
 *  seed), both at the table, which plays G; A has a slip down in G, which both tabs see. */
async function twoTabs(): Promise<{ a: Page; b: Page; at: number }> {
  const [a] = await twoGames();
  const b = await loadPage("A'", 9, { reloadOf: a });
  sync(T0, a, b);
  const at = run([a, b], T0 + STEP, T0 + 3_000, { step: STEP });
  expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
  sync(at, a, b);
  expect(b.pub).toBe(a.pub);
  expect(b.casino.computedFoldOf(TABLE, G.inc)!.felts.has(a.pid)).toBe(true);
  return { a, b, at };
}

/** Frames of page b alone every STEP ms from `from` to `to`, until `until` holds after one (the time it did, or to + STEP):
 *  its player's other tab a is gone from the room (it takes no frame and writes nothing), and its doc only carries the
 *  house's beats, which the Beating writes in it, to b. */
function runAlone(b: Page, a: Page, from: number, to: number, until: () => boolean): number {
  for (let T = from; T <= to; T += STEP) {
    beat?.each(T);
    sync(T, a, b);
    frame(T, b);
    sync(T, a, b);
    if (until()) return T;
  }
  return to + STEP;
}

describe('a game the table has left, of which the page holds only what its player\'s other tab put in', () => {
  it('is served for the felt that tab wrote: with that tab gone, its round is closed when the window has run out', async () => {
    const { a, b, at } = await twoTabs();
    nameGame(a, G2.inc);
    sync(at, a, b);
    expect(b.casino.computedIncOf(TABLE)).toBe(G2.inc);
    expect(inSession(a, G.inc, 'c', 1)).toEqual([]);
    const closedAt = runAlone(b, a, at + STEP, at + 60_000, () => inSession(b, G.inc, 'c', 1).length > 0);
    expect(inSession(b, G.inc, 'c', 1)).toHaveLength(1);
    // (after the window, and the turns of the tabs that could close it, as at the table: GRACE_MAX_MS more for the other tab's close)
    expect(closedAt).toBeGreaterThanOrEqual(at + b.table.BET_WINDOW_MS);
    expect(closedAt).toBeLessThanOrEqual(at + b.table.BET_WINDOW_MS + b.table.STAGGER_MS + b.table.GRACE_MAX_MS + STEP * 4);
  });

  it('is served for the copies it keeps of what that tab put in: the slip the doc lost goes back, the tab gone', async () => {
    const { a, b, at } = await twoTabs();
    nameGame(a, G2.inc);
    const closedAt = run([a, b], at + STEP, at + 60_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    // (the close froze the slip, and the page keeps a copy of it while it is in the round)
    const shown = run([a, b], closedAt + STEP, closedAt + 2_000, { step: STEP });
    const [s] = inSession(a, G.inc, 's', 1);
    const value = recIn(a, G.inc, s);
    const sesKey = [...top(a).keys()].find((k) => k.startsWith(`ses:${TABLE}:${G.inc}:`))!;
    a.doc.transact(() => (top(a).get(sesKey) as Y.Map<unknown>).delete(s));
    expect(inSession(a, G.inc, 's', 1)).toEqual([]);
    const backAt = runAlone(b, a, shown, shown + 30_000, () => inSession(b, G.inc, 's', 1).length > 0);
    expect(inSession(b, G.inc, 's', 1)).toEqual([s]);
    expect(recIn(b, G.inc, s)).toEqual(value);
    // (in its turn, as the witness it is: REPUT_MS and a stagger after it saw the slip missing)
    expect(backAt).toBeGreaterThanOrEqual(shown + 1_000);
    expect(backAt).toBeLessThanOrEqual(shown + 1_000 + 1_500 + 1_000 + STEP * 2);
  });
});

describe('the games of a table, read by their names', () => {
  it('each by its own fold and session: the readers that take the game\'s name give its records, those that do not give the game played', async () => {
    const [a] = await twoGames();
    const at = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    expect(a.table.writeComputedSlip(TABLE, [red(9)], at)).toBe('ok');
    nameGame(a, G2.inc);
    run([a], at + STEP, at + 40_000, { step: STEP, until: () => inSession(a, G.inc, 'c', 1).length > 0 });
    const one = a.casino.computedFoldOf(TABLE, G.inc)!;
    const two = a.casino.computedFoldOf(TABLE, G2.inc)!;
    expect(a.casino.computedFoldOf(TABLE)).toBe(two);
    expect(one).not.toBe(two);
    expect(one.felts.size).toBe(1);
    expect(two.felts.size).toBe(0);
    expect(a.casino.computedSessionForWrite(TABLE)).toBe(a.casino.computedSessionForWrite(TABLE, G2.inc));
    expect(a.casino.computedSessionForWrite(TABLE, G.inc)).not.toBe(a.casino.computedSessionForWrite(TABLE));
    expect(a.casino.computedSessionForWrite(TABLE, G.inc)?.size).toBeGreaterThan(0);
    // (the players a close froze are the game's: the other has none)
    expect([...a.casino.computedTablePids(TABLE, G.inc)]).toEqual([a.pid]);
    expect([...a.casino.computedTablePids(TABLE)]).toEqual([]);
    expect(a.casino.computedTablePidBytes(TABLE, G.inc)).toBeGreaterThan(a.casino.computedTablePidBytes(TABLE));
    // (a name no live game of the table has is none)
    const nobody = faironlyInc('p', PAGE_ROOM, TABLE, { ...NAME, j: '0000000000000001' });
    expect(a.casino.computedFoldOf(TABLE, nobody)).toBeNull();
    expect(a.casino.computedSessionForWrite(TABLE, nobody)).toBeNull();
    // the game left ends: it is none to write in, the one played goes on
    const end = trimOf(G, 'p', {
      ok: NAME.ok, j: NAME.j, u: 5, l: hex('e', 32), e: 1, f: sealFin(G, owner.pub, owner.sign).value, s: undefined, h: undefined, k: owner.pub, dl: undefined, n: {},
    });
    a.doc.transact(() => top(a).set(end.key, end.value));
    expect(a.casino.computedResolutionOf(TABLE, G.inc)).toMatchObject({ live: false });
    expect(a.casino.computedSessionForWrite(TABLE, G.inc)).toBeNull();
    expect(a.casino.computedSessionForWrite(TABLE)).toBe(a.casino.computedSessionForWrite(TABLE, G2.inc));
    expect(a.casino.computedIncOf(TABLE)).toBe(G2.inc);
  });
});

describe('the duties of computedTable.ts', () => {
  it('read the game of the state they serve: none of the readers that follow the game played is asked for st.t alone', () => {
    const raw = readFileSync(new URL('./computedTable.ts', import.meta.url), 'utf8');
    // (comments blanked, their length kept)
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
    // The readers that answer for the game played unless given a game's name last, and how many arguments come before it.
    const readers: [string, number][] = [
      ['computedFoldOf', 1], ['computedRedecide', 1], ['computedSessionForWrite', 1], ['computedTablePids', 1], ['computedTablePidBytes', 1],
      ['computedSeenAt', 2], ['computedSlipDoubted', 2], ['markComputedVerdict', 2], ['pidRoomOf', 1], ['crowdedOut', 2],
    ];
    /** The arguments of the call whose '(' is at `open`: commas at its own level, strings and templates skipped. */
    const argsOf = (open: number): number => {
      let depth = 0;
      let args = 1;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
          for (i++; src[i] !== c; i++) if (src[i] === '\\') i++;
          continue;
        }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          if (--depth === 0) return args;
        } else if (c === ',' && depth === 1) args++;
      }
      return -1;
    };
    let calls = 0;
    for (const [name, before] of readers) {
      for (const m of src.matchAll(new RegExp(`\\b${name}\\(st\\.t\\b`, 'g'))) {
        const line = src.slice(0, m.index).split('\n').length;
        expect(argsOf(m.index! + name.length), `${name} at line ${line}`).toBe(before + 1);
        calls += 1;
      }
    }
    // (not vacuous: the duties that have a state ask for it by name in two dozen places)
    expect(calls).toBeGreaterThanOrEqual(24);
  });
});

/** More games of the owner's at the table (names after the first two), each opened in page a's doc beside G and G2. */
function openMore(a: Page, count: number): FoldCtx[] {
  const out: FoldCtx[] = [];
  for (let i = 1; i <= count; i++) {
    const NAMEN = { ...NAME, j: `0123456789abc${i.toString(16).padStart(3, '0')}` };
    const ctx: FoldCtx = { room: PAGE_ROOM, t: TABLE, inc: faironlyInc('p', PAGE_ROOM, TABLE, NAMEN) };
    const rootN = rootOf(ctx, 'p', { j: NAMEN.j, dl: delegation(owner, H.pub, PAGE_ROOM) });
    a.doc.transact(() => {
      top(a).set(rootN.key, rootN.value);
      top(a).set(`ses:${TABLE}:${ctx.inc}:${nextSid3(ctx, rootN.value)}`, new Y.Map());
    });
    out.push(ctx);
  }
  return out;
}

describe('what serving every game costs a frame', () => {
  it('a step of a table with six live games, a state of the page for each, asks it a handful of times: the game played needs no cache', async () => {
    const [a] = await twoGames();
    const more = openMore(a, 4);
    // (the table plays each in turn, so that the page keeps a state for each)
    let t = run([a], T0 + STEP, T0 + 1_000, { step: STEP });
    for (const inc of [G2.inc, ...more.map((g) => g.inc)]) {
      nameGame(a, inc);
      t = run([a], t, t + 1_000, { step: STEP });
    }
    expect(a.casino.computedIncOf(TABLE)).toBe(more[more.length - 1].inc);
    const steps = 10;
    const before = asked.tableGame;
    run([a], t, t + (steps - 1) * STEP, { step: STEP });
    const looks = asked.tableGame - before;
    expect(looks).toBeGreaterThan(0);
    // (measured at 4 a step, however many states the page keeps for the table: 3 in the tick of the game played, and one for the pass over the others)
    expect(looks / steps).toBeLessThanOrEqual(5);
  });

  it('a game the page has nothing in is not served: a table with three costs a step the compaction\'s look at each and no duty\'s gates', async () => {
    const [a, b] = await twoGames(['A', 'B']);
    // (the gates of a table's duties, asked of the casino module the table's duties call)
    const gates = [vi.spyOn(a.casino, 'casinoWhole'), vi.spyOn(a.casino, 'computedSettled')];
    const asks = (): number => gates.reduce((n, spy) => n + spy.mock.calls.length, 0);
    const steps = 10;
    let t = run([a, b], T0 + STEP, T0 + 1_000, { step: STEP });
    // (another player's felt in the first game: not the page's, which has put nothing in it)
    clockOf(b, t);
    expect(b.table.writeComputedSlip(TABLE, [red(9)], t)).toBe('ok');
    sync(t, a, b);
    expect(a.casino.computedFoldOf(TABLE, G.inc)!.felts.has(b.pid)).toBe(true);
    const alone = asks();
    t = run([a], t, t + (steps - 1) * STEP, { step: STEP });
    const one = asks() - alone;
    expect(one).toBeGreaterThan(0);
    const [G3] = openMore(a, 1);
    for (const inc of [G2.inc, G3.inc]) {
      nameGame(a, inc);
      t = run([a], t, t + 1_000, { step: STEP });
    }
    expect(a.casino.computedIncOf(TABLE)).toBe(G3.inc);
    const before = asks();
    run([a], t, t + (steps - 1) * STEP, { step: STEP });
    const three = asks() - before;
    // (measured at one ask a step for each of the two other games: compactDuty's, which looks at every state it keeps)
    expect(three - one).toBeLessThanOrEqual(steps * 2);
  });

  it('a game left is served once in TICK_MS however often the page draws a frame: the same stretch of time drawn four times as often reads its fold as often', async () => {
    const [a] = await twoGames();
    let t = run([a], T0 + STEP, T0 + 3_000, { step: STEP });
    // (a slip of the page's in the first game, which the table then leaves: its state is served)
    expect(a.table.writeComputedSlip(TABLE, [red(9)], t)).toBe('ok');
    nameGame(a, G2.inc);
    t = run([a], t, t + 1_000, { step: STEP });
    expect(a.casino.computedIncOf(TABLE)).toBe(G2.inc);
    const folds = vi.spyOn(a.casino, 'computedFoldOf');
    const ofLeft = (): number => folds.mock.calls.filter((args) => args[1] === G.inc).length;
    // (three seconds at a frame every TICK_MS, then three at a frame every 50 ms, inside the betting window both)
    const before = ofLeft();
    run([a], t, t + 3_000, { step: STEP });
    const slow = ofLeft() - before;
    const mid = ofLeft();
    run([a], t + 3_000 + 50, t + 6_000, { step: 50 });
    const fast = ofLeft() - mid;
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeLessThanOrEqual(slow * 1.5);
  });
});
