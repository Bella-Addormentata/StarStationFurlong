/**
 * 🧪🧮🎡 Pages for computed-table specs (computedTable.ts) — for specs only;
 * no app code imports it.
 *
 * Each page is its own load of the casino modules (vi.resetModules), with its
 * own Y.Doc, its own player id (./identity mocked for that load alone) and
 * its own identity key (node has no localStorage, so each fresh keypair
 * module mints one, and each fresh seed store keeps its seeds to itself, as
 * two devices do). Pages are synced by hand, and every clock is explicit:
 * a spec fakes Date only, and a page's clock is the spec's time plus the
 * page's skew, set as the system time whenever the page hears an update or
 * runs a frame, so casinoDoc's arrival stamps are on that page's clock.
 *
 * A spec can choose a page's next fresh seeds (its `seeds` queue, drawn
 * before any random one: fairDice randomSeedHex), so a craps roll's dice
 * are the ones it wants (rigRoll); and where the page's table session
 * stands (standAt), as a mounted craps table session marks it.
 */

import { vi } from 'vitest';
import * as Y from 'yjs';
import { diceOf } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
import { gameOfInc, seedTable } from './computedFold';
import type { FoldCtx, SignedKind } from './computedFold';
import type { ComputedTableRef } from './computedTable';
import { ComputedKit } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import type { CrapsBet } from './games/craps';

export interface Page {
  name: string;
  pid: string;
  /** This page's identity pub (base64url). */
  pub: string;
  /** Its clock: the spec's time + skew. */
  skew: number;
  doc: Y.Doc;
  casino: typeof import('./casinoDoc');
  croupier: typeof import('./croupier');
  table: typeof import('./computedTable');
  fair: typeof import('./fairTableSeeds');
  fold: typeof import('./computedFold');
  keypair: typeof import('./keypair');
  stands: typeof import('./localStands');
  /** Its robot at the players' tables (computedRobot), of this load. */
  robot: typeof import('./computedRobot');
  /** This page's next fresh seeds, drawn first (then random ones). */
  seeds: string[];
}

/** The room every page binds unless a spec says otherwise. */
export const PAGE_ROOM = 'room-ct';
export const PAGE_TABLE = 'roulette-1';
export const PAGE_INC = 'c' + '5a'.repeat(12);
export const PAGE_CTX: FoldCtx = { room: PAGE_ROOM, t: PAGE_TABLE, inc: PAGE_INC };
/** …and the craps table, under a craps name. */
export const CRAPS_TABLE = 'craps-1';
export const CRAPS_INC = 'k' + '5a'.repeat(12);
export const CRAPS_CTX: FoldCtx = { room: PAGE_ROOM, t: CRAPS_TABLE, inc: CRAPS_INC };
export const CRAPS_REF: ComputedTableRef = { id: CRAPS_TABLE, game: 'craps' };

/** A page for player `pid` (Yjs client `clientID`), its key shown in the
 *  room's players map as main.ts shows it. Its checks never run out of time
 *  unless `verify` gives them a clock and a budget (casinoDoc
 *  setComputedVerifyForTests); `resync` is what its doc calls to ask the room
 *  for what it is missing (bindCasinoDoc's, YjsSync's resync in the app).
 *  With `hears`, its tables listen to the room as main.ts has them listen
 *  (computedTable listenToRoom): a forfeit goes only from a page that has
 *  heard the room since the close came, and the spec (computedSim) tells
 *  it each tick it hears; without, it hears the room always, as a page with
 *  no room does (offline practice, the specs that hand docs over by hand). */
export async function loadPage(
  name: string,
  clientID: number,
  opts: {
    skew?: number; pid?: string; reloadOf?: Page; resync?: () => void; verify?: { now: () => number; budgetMs: number }; hears?: boolean;
  } = {},
): Promise<Page> {
  const pid = opts.reloadOf?.pid ?? opts.pid ?? `player-${name}`;
  vi.resetModules();
  vi.doMock('./identity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./identity')>()),
    getPlayerId: () => pid,
  }));
  // A reload keeps the device's key (its localStorage), and nothing else:
  // its seed store, what it wrote and what it saw start afresh.
  const kept = opts.reloadOf?.keypair;
  if (kept) vi.doMock('./keypair', () => kept);
  else vi.doUnmock('./keypair');
  const seeds: string[] = [];
  vi.doMock('./games/fairDice', async (importOriginal) => {
    const real = await importOriginal<typeof import('./games/fairDice')>();
    return { ...real, randomSeedHex: () => seeds.shift() ?? real.randomSeedHex() };
  });
  const casino = await import('./casinoDoc');
  const croupier = await import('./croupier');
  const table = await import('./computedTable');
  const fair = await import('./fairTableSeeds');
  const fold = await import('./computedFold');
  const keypair = await import('./keypair');
  const stands = await import('./localStands');
  const robot = await import('./computedRobot');
  // (This load's own modules: a reload listens afresh, as a page loaded again does.)
  if (opts.hears) table.listenToRoom();
  const doc = new Y.Doc();
  doc.clientID = clientID;
  casino.setComputedVerifyForTests(opts.verify ?? { now: () => 0 });
  casino.bindCasinoDoc(doc, PAGE_ROOM, opts.resync);
  const pub = keypair.getIdentityPub();
  doc.transact(() => doc.getMap('players').set(pid, { keyB64: pub, name: pid }));
  return { name, pid, pub, skew: opts.skew ?? 0, doc, casino, croupier, table, fair, fold, keypair, stands, robot, seeds };
}

/** Pages for `names` (Yjs clients 1, 2, …, clocks `skews` ahead of the
 *  spec's), 1,000 chips each, the table switched on by the first, all synced
 *  at the spec's time T. */
export async function openRoom(names: string[], T: number, skews: number[] = [], at: { t: string; inc: string } = { t: PAGE_TABLE, inc: PAGE_INC }): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) pages.push(await loadPage(name, i + 1, { skew: skews[i] ?? 0 }));
  for (const p of pages) {
    clockOf(p, T);
    p.casino.buyInChips(p.pid, 1_000);
  }
  switchOn(pages[0], at.t, at.inc);
  sync(T, ...pages);
  return pages;
}

/** …the craps table switched on instead. */
export function openCrapsRoom(names: string[], T: number, skews: number[] = []): Promise<Page[]> {
  return openRoom(names, T, skews, { t: CRAPS_TABLE, inc: CRAPS_INC });
}

/** Page p's clock at the spec's time T, set as the system time. */
export function clockOf(p: Page, T: number): number {
  const now = T + p.skew;
  vi.setSystemTime(now);
  return now;
}

/** Hand every page every other page's updates at the spec's time T. */
export function sync(T: number, ...pages: Page[]): void {
  for (const x of pages) {
    for (const y of pages) {
      if (x === y) continue;
      const diff = Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc));
      clockOf(y, T);
      Y.applyUpdate(y.doc, diff);
    }
  }
}

/** Page x's updates to page y alone, at T. */
export function send(T: number, x: Page, y: Page): void {
  const diff = Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc));
  clockOf(y, T);
  Y.applyUpdate(y.doc, diff);
}

/** One frame of page p at T: it runs its tables (croupier noteTablesRunning,
 *  as World does every frame) and ticks the computed one. */
export function frame(T: number, p: Page, tables: ComputedTableRef[] = [PAGE_TABLE]): void {
  const now = clockOf(p, T);
  p.croupier.noteTablesRunning(now);
  p.table.tickComputedTables(tables, now);
}

/** Frames of `pages` every `step` ms from `from` to `to` (inclusive), each
 *  synced before it runs; stops early, returning the time, once `until`
 *  holds after a step. Returns `to` + step when it never did. */
export function run(
  pages: Page[], from: number, to: number, opts: { step?: number; until?: () => boolean; tables?: ComputedTableRef[] } = {},
): number {
  const step = opts.step ?? 100;
  for (let T = from; T <= to; T += step) {
    sync(T, ...pages);
    for (const p of pages) frame(T, p, opts.tables);
    sync(T, ...pages);
    if (opts.until?.()) return T;
  }
  return to + step;
}

/** The house's switch-on, as commit 4 writes it: the switch and the first
 *  session, on page p. */
export function switchOn(p: Page, t = PAGE_TABLE, inc = PAGE_INC): void {
  p.doc.transact(() => {
    p.doc.getMap('casino').set(`cfg:computed:${t}`, { v: 1, inc });
    p.doc.getMap('casinoComputed').set(`ses:${t}:${inc}:g`, new Y.Map());
  });
}

/** `body` signed by page p's key for `ctx` (k = p's pub): a record as p's
 *  page would sign it, for a spec to write by hand (a cheat, a rival). */
export function signAs<T extends object>(p: Page, kind: SignedKind, body: T, ctx: FoldCtx = PAGE_CTX): T & { k: string; g: string } {
  const withKey = { ...body, k: p.pub };
  return { ...withKey, g: p.keypair.signIdentity(p.fold.signBytes(kind, ctx, withKey)) };
}

/** The updates page p sends while `act` runs, one per transaction: what
 *  another page can be handed apart from the rest of p's doc. */
export function updatesOf(p: Page, act: () => void): Uint8Array[] {
  const out: Uint8Array[] = [];
  const take = (u: Uint8Array): void => { out.push(u); };
  p.doc.on('update', take);
  try {
    act();
  } finally {
    p.doc.off('update', take);
  }
  return out;
}

/** Hand page y updates `us` at the spec's time T. */
export function deliver(T: number, y: Page, us: Uint8Array[]): void {
  clockOf(y, T);
  for (const u of us) Y.applyUpdate(y.doc, u);
}

/** Write records into table t's live session on page p, one transaction. */
export function putIn(p: Page, recs: [key: string, rec: unknown][], t = PAGE_TABLE): void {
  const ses = p.casino.computedSessionForWrite(t);
  if (!ses) throw new Error(`${p.name}: ${t} has no live session`);
  p.doc.transact(() => {
    for (const [key, rec] of recs) ses.set(key, rec);
  });
}

/** Delete keys from table t's live session on page p, one transaction. */
export function deleteIn(p: Page, keys: string[], t = PAGE_TABLE): void {
  const ses = p.casino.computedSessionForWrite(t);
  if (!ses) throw new Error(`${p.name}: ${t} has no live session`);
  p.doc.transact(() => {
    for (const key of keys) ses.delete(key);
  });
}

/** The keys of table t's live session on page p of record kind `kind`
 *  (s, c, x, f, z) and round r (any round when left out). */
export function keysIn(p: Page, kind: string, r?: number, t = PAGE_TABLE): string[] {
  const ses = p.casino.computedSessionForWrite(t);
  if (!ses) return [];
  const prefix = r === undefined ? `${kind}:` : `${kind}:${r}:`;
  return [...ses.keys()].filter((k) => k.startsWith(prefix)).sort();
}

/** Pages sorted by their rank for `duty` on round r (lower goes first). */
export function byRank(pages: Page[], duty: 'close' | 'forfeit' | 'abandon' | 'trim', r: number, ctx: FoldCtx = PAGE_CTX): Page[] {
  const rank = new Map(pages.map((p) => [p, p.fold.dutyRank(duty, ctx, r, p.pub)]));
  return [...pages].sort((a, b) => (rank.get(a)! < rank.get(b)! ? -1 : 1));
}

/** Trim table t's live session by hand on page p, as commit 3's trim will:
 *  a checkpoint at the last decided round (signed by `id`, nets the fold's
 *  unless given; at a craps name with the table's state after it, or
 *  `carry`), the old session gone, the open round's felts copied into the
 *  new one, all in one transaction. The new session's id. */
export function trimByHand(p: Page, id: TestIdentity, nets?: Record<string, bigint>, t = PAGE_TABLE, given?: CrapsCarry): string {
  const res = p.casino.computedFoldOf(t)!;
  const inc = p.casino.computedIncOf(t)!;
  const kit = new ComputedKit({ room: PAGE_ROOM, t, inc });
  const D = res.rounds.filter((v) => v.decided).at(-1)!;
  const carry = gameOfInc(inc) === 'craps' ? given ?? (res.carry as CrapsCarry) : undefined;
  const cp = kit.checkpoint(id, res.base.sid, D.r, D.close, nets ?? Object.fromEntries(res.nets), undefined, carry, res.required ?? undefined);
  const sid = kit.sidAfter(cp);
  const old = p.casino.computedSessionForWrite(t)!;
  const copies = [...res.felts.values()].map((s): [string, unknown] => [s.key, old.get(s.key)]);
  for (const j of res.joins) copies.push([`o:${res.open}:${j.hash}`, old.get(`o:${res.open}:${j.hash}`)]);
  p.doc.transact(() => {
    const m = p.doc.getMap('casinoComputed');
    m.set(`sum:${t}:${inc}`, cp);
    for (const k of [...m.keys()]) if (k.startsWith(`ses:${t}:${inc}:`)) m.delete(k);
    const ses = new Y.Map<unknown>();
    m.set(`ses:${t}:${inc}:${sid}`, ses);
    for (const [k, v] of copies) ses.set(k, v);
  });
  return sid;
}

// ── 🎲 Craps ─────────────────────────────────────────────────────────────────

/** Page p's table session standing at craps stand `stand` (1–7), or at
 *  none (null: off the table), as a mounted one marks it. */
export function standAt(p: Page, stand: number | null, t = CRAPS_TABLE): void {
  p.stands.setLocalStand(t, p.pid, stand !== null, stand);
}

/** The craps table's state on page p (readComputedCraps). */
export function crapsOf(p: Page, now?: number, t = CRAPS_TABLE) {
  return p.table.readComputedCraps(t, now);
}

/** The table's carried state on page p: the point, the riding bets, the dice. */
export function carryOf(p: Page, t = CRAPS_TABLE): CrapsCarry {
  return p.casino.computedFoldOf(t)!.carry as CrapsCarry;
}

/** Page p puts its whole felt `bets` down on the open roll at T, as its
 *  table session does: built on the table as p has it now. */
export function crapsBet(p: Page, bets: CrapsBet[], T: number, t = CRAPS_TABLE) {
  const now = clockOf(p, T);
  const v = p.table.readComputedCraps(t, now);
  const { basis } = p.table.readMyComputedCrapsBets(t, p.pid, v?.round ?? 0, now);
  return p.table.writeComputedCrapsSlip(t, bets, basis, now);
}

/** A seed from a tag. */
export function tagSeed(tag: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    for (const ch of `${tag}#${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out.push(h.toString(16).padStart(8, '0'));
  }
  return out.join('');
}

/** Queue on each of `pages` its next fresh seed so that roll r's dice, from
 *  their seeds and `others` (seeds already committed), sum to `sum`. */
export function rigRoll(pages: Page[], r: number, sum: number, others: string[] = [], ctx: FoldCtx = CRAPS_CTX): void {
  const rest = pages.slice(1).map((p) => tagSeed(`${p.name}:${r}:${sum}`));
  for (let n = 0; n < 10_000; n++) {
    const first = tagSeed(`${pages[0].name}:${r}:${sum}:${n}`);
    const [d1, d2] = diceOf(seedTable(ctx), r, [first, ...rest, ...others]);
    if (d1 + d2 !== sum) continue;
    pages[0].seeds.push(first);
    pages.slice(1).forEach((p, i) => p.seeds.push(rest[i]));
    return;
  }
  throw new Error(`rigRoll: no seeds for ${sum}`);
}

/** Queue roll r's seeds on `pages` so that all of theirs make `both` and
 *  the seed of `w` alone (a forfeit counting w only) makes `alone`. */
export function rigSplit(pages: Page[], r: number, both: number, w: Page, alone: number, ctx: FoldCtx = CRAPS_CTX): void {
  const table = seedTable(ctx);
  const sum = (seeds: string[]): number => diceOf(table, r, seeds).reduce((x, d) => x + d, 0);
  for (let n = 0; n < 100_000; n++) {
    const seeds = pages.map((p) => tagSeed(`${p.name}:${r}:split:${n}`));
    if (sum([seeds[pages.indexOf(w)]]) !== alone || sum(seeds) !== both) continue;
    pages.forEach((p, i) => p.seeds.push(seeds[i]));
    return;
  }
  throw new Error(`rigSplit: no seeds for ${both} / ${alone}`);
}

/** Queue roll r's seeds on `pages` so that the seeds of each of `sums`'
 *  sets of pages make its total (a forfeit counting that set): `[pages, 6]`
 *  for all of them. */
export function rigSums(pages: Page[], r: number, sums: [Page[], number][], ctx: FoldCtx = CRAPS_CTX): void {
  const table = seedTable(ctx);
  const sum = (seeds: string[]): number => diceOf(table, r, seeds).reduce((x, d) => x + d, 0);
  for (let n = 0; n < 400_000; n++) {
    const seeds = pages.map((p) => tagSeed(`${p.name}:${r}:sums:${n}`));
    if (!sums.every(([set, want]) => sum(set.map((p) => seeds[pages.indexOf(p)])) === want)) continue;
    pages.forEach((p, i) => p.seeds.push(seeds[i]));
    return;
  }
  throw new Error(`rigSums: no seeds for ${sums.map(([set, want]) => `${set.length}:${want}`).join(' ')}`);
}

/** Queue roll r's seeds on `pages` so that all of theirs and the seed of `w`
 *  alone throw the same dice, summing to `sum`: a forfeit counting w only
 *  decides the roll again on the same faces. */
export function rigSame(pages: Page[], r: number, sum: number, w: Page, ctx: FoldCtx = CRAPS_CTX): void {
  const table = seedTable(ctx);
  for (let n = 0; n < 100_000; n++) {
    const seeds = pages.map((p) => tagSeed(`${p.name}:${r}:same:${n}`));
    const all = diceOf(table, r, seeds);
    const alone = diceOf(table, r, [seeds[pages.indexOf(w)]]);
    if (all[0] + all[1] !== sum || all[0] !== alone[0] || all[1] !== alone[1]) continue;
    pages.forEach((p, i) => p.seeds.push(seeds[i]));
    return;
  }
  throw new Error(`rigSame: no seeds for ${sum}`);
}

/** Pages `names` at craps stands `stands` (null: off the table), synced,
 *  bet the pass line on roll 1 at T (`amounts`: 10, 5, 20, 15 by default)
 *  and roll a 6: the point is on, every pass riding on it, the dice with
 *  the first of their stands clockwise. When roll 1 decided on every page
 *  (framed every `step` ms), and when its show ends there. */
export async function crapsPointOn(names: string[], stands: (number | null)[], T: number, opts: { amounts?: number[]; step?: number } = {}) {
  const amounts = opts.amounts ?? [10, 5, 20, 15];
  const pages = await openCrapsRoom(names, T);
  pages.forEach((p, i) => standAt(p, stands[i] ?? null));
  rigRoll(pages, 1, 6);
  for (const [i, p] of pages.entries()) {
    const put = crapsBet(p, [{ type: 'pass', amount: amounts[i] }], T);
    if (put !== 'ok') throw new Error(`crapsPointOn: ${p.name}'s pass: ${put}`);
  }
  sync(T, ...pages);
  const decided = (p: Page): boolean => p.casino.computedFoldOf(CRAPS_TABLE)?.rounds[0]?.decided === 'reveals';
  const step = opts.step ?? 200;
  const decidedAt = run(pages, T + step, T + 60_000, { step, tables: [CRAPS_REF], until: () => pages.every(decided) });
  if (!pages.every(decided) || pages.some((p) => carryOf(p).p !== 6)) throw new Error('crapsPointOn: roll 1 made no point');
  const showEnd = crapsOf(pages[0], decidedAt)!.resultAt + pages[0].croupier.CRAPS_SHOW_MS;
  return { pages, decidedAt, showEnd };
}
