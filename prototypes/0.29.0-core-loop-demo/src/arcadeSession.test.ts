/**
 * 🕹️ Shared arcade games across a room, end to end: several pages, each with
 * its own copy of the session, gamesDoc and room doc (synced as Yjs updates),
 * passing the arcade ticks between them, some lost. Every page's cabinet
 * screen is hashed as it is painted, keyed by the frame it shows, and pages
 * must agree on every frame they both painted: the host, player 2 over the
 * network, a watcher from the start, a watcher who walks in late (a save
 * state), and a watcher whose copy is knocked off course (a resync).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARCADE_GAMES, type ArcadeGame } from './arcadeLibrary';
import { PAD_BIT, packArcadeTick, unpackArcadeTick } from './arcadeNet';

type SessionModule = typeof import('./arcadeSession');
type GamesModule = typeof import('./games/gamesDoc');
type CasinoModule = typeof import('./casinoDoc');
type YModule = typeof import('yjs');

const ITEM = 'arcade-1';
const romBytes = new Map(
  ARCADE_GAMES.map((g) => [g.romUrl, new Uint8Array(readFileSync(new URL(`../public${g.romUrl}`, import.meta.url)))]),
);
const THWAITE = ARCADE_GAMES.find((g) => g.id === 'thwaite')!;

const hashFrame = (frame: Uint32Array) => {
  let h = 2166136261;
  for (let i = 0; i < frame.length; i++) h = Math.imul(h ^ frame[i], 16777619);
  return h >>> 0;
};

interface Page {
  name: string;
  lane: string;
  mod: SessionModule;
  games: GamesModule;
  casino: CasinoModule;
  Y: YModule;
  doc: InstanceType<YModule['Doc']>;
  /** Painted frames: the frame number each shows → its hash. */
  hashes: Map<number, number>;
  cards: string[];
  attract: number;
  /** Ticks sent this update (delivered by run()), and every tick sent. */
  outbox: Uint8Array[];
  sent: Uint8Array[];
  viewer: { x: number; z: number } | null;
  /** Closed the tab: no frames, no ticks, no doc updates either way. */
  closed: boolean;
}

/** Ticks from → to that get lost (default: none). */
let lose: (from: Page, to: Page, bytes: Uint8Array) => boolean = () => false;
/** A tick on its way from → to, rewritten (default: as sent). */
let rewrite: (from: Page, to: Page, bytes: Uint8Array) => Uint8Array = (_f, _t, b) => b;
let pages: Page[] = [];

/** A new page in the room: fresh modules (its own page id and player id),
 *  its doc caught up with the room's. */
async function openPage(name: string, viewer: { x: number; z: number } | null = null): Promise<Page> {
  vi.resetModules();
  const Y = await import('yjs');
  const casino = await import('./casinoDoc');
  const games = await import('./games/gamesDoc');
  const mod = await import('./arcadeSession');
  const doc = new Y.Doc();
  for (const other of pages) if (!other.closed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(other.doc), 'room');
  casino.bindCasinoDoc(doc);
  games.bindGamesDoc(doc);
  const page: Page = {
    name, lane: `lane-${name}`, mod, games, casino, Y, doc,
    hashes: new Map(), cards: [], attract: 0, outbox: [], sent: [], viewer, closed: false,
  };
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'room' || page.closed) return;
    for (const other of pages) if (other !== page && !other.closed) other.Y.applyUpdate(other.doc, update, 'room');
  });
  mod.setArcadeRomFetcher(async (url) => romBytes.get(url)!);
  mod.setArcadeSender((buf) => {
    page.outbox.push(buf.slice());
    page.sent.push(buf.slice());
  });
  mod.registerArcadeVisual(ITEM, {
    painter: {
      drawFrame: (frame: Uint32Array) => {
        const info = mod.arcadeCopyInfo(ITEM);
        if (info) page.hashes.set(info.next - 1, hashFrame(frame));
      },
      drawMenu: () => undefined,
      drawCredits: () => undefined,
      drawCard: (_title: string, line: string) => page.cards.push(line),
      drawAttract: () => undefined,
    },
    present: () => undefined,
    showAttract: () => page.attract++,
  }, { x: 0, z: 0 });
  pages.push(page);
  return page;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run every open page for `ms` of game time at 60 updates a second.
 *  `each` runs before every update (set pads, join…). */
async function run(ms: number, each?: (step: number) => void): Promise<void> {
  const steps = Math.round(ms / (1000 / 60));
  for (let i = 0; i < steps; i++) {
    vi.setSystemTime(Date.now() + 1000 / 60);
    each?.(i);
    for (const p of pages) if (!p.closed) p.mod.arcadeFrame(1 / 60, p.viewer);
    for (const from of pages) {
      for (const bytes of from.outbox) {
        for (const to of pages) {
          if (to === from || to.closed || from.closed || lose(from, to, bytes)) continue;
          to.mod.routeArcadeTick(from.lane, rewrite(from, to, bytes));
        }
      }
      from.outbox.length = 0;
    }
    await flush(); // ROM loads and save states are promises
  }
}

/** Attach a page to the cabinet as the UI would while a shared game shows. */
function link(page: Page, seat: 0 | 1, seats: 1 | 2) {
  const l = page.mod.linkArcade(ITEM, seat, seats);
  l.setUiScreen(false);
  return l;
}

/** A pad script: each pad held 4–30 frames (a quick tap is about 4). */
function padScript(seed: number) {
  let s = seed >>> 0;
  let cur = 0;
  let left = 0;
  return () => {
    if (left-- <= 0) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      cur = (s >>> 8) & 0xf3; // A, B and the D-pad: never Select/Start mid-test
      left = 4 + ((s >>> 20) % 27);
    }
    return cur;
  };
}

/** Another cabinet on the page, whose screen nobody checks. */
function addCabinet(page: Page, itemId: string): void {
  page.mod.registerArcadeVisual(itemId, {
    painter: {
      drawFrame: () => undefined,
      drawMenu: () => undefined,
      drawCredits: () => undefined,
      drawCard: () => undefined,
      drawAttract: () => undefined,
    },
    present: () => undefined,
    showAttract: () => undefined,
  }, { x: 4, z: 0 });
}

/** Frames both pages painted, and how many of them disagree. */
function compare(a: Page, b: Page, from = 0): { common: number; differ: number[] } {
  let common = 0;
  const differ: number[] = [];
  for (const [frame, hash] of b.hashes) {
    if (frame < from || !a.hashes.has(frame)) continue;
    common++;
    if (a.hashes.get(frame) !== hash) differ.push(frame);
  }
  return { common, differ };
}

const ticksOf = (page: Page, type: 'frames' | 'guest' | 'sync') =>
  page.sent.filter((b) => unpackArcadeTick(b)?.type === type);

/** The page goes to a room (main.ts publishes its id, then binds its doc). */
function moveRoom(page: Page, id: string): void {
  setRoom(id);
  page.doc = new page.Y.Doc();
  page.casino.bindCasinoDoc(page.doc);
  page.games.bindGamesDoc(page.doc);
}

const setRoom = (id: string | undefined) => {
  (globalThis as { __ssfRoomId?: string }).__ssfRoomId = id;
};

afterEach(() => {
  setRoom(undefined);
  pages = [];
  lose = () => false;
  rewrite = (_f, _t, b) => b;
  vi.useRealTimers();
});

async function room(...names: Array<[string, { x: number; z: number } | null]>): Promise<Page[]> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
  const out: Page[] = [];
  for (const [name, viewer] of names) out.push(await openPage(name, viewer));
  return out;
}

async function startGame(host: Page, seat: 0 | 1, seats: 1 | 2, game: ArcadeGame = THWAITE) {
  const l = link(host, seat, seats);
  l.host(game);
  expect(l.shared()?.phase).toBe('loading');
  await run(100);
  expect(l.shared()).toMatchObject({ role: 'host', phase: 'playing', title: game.title });
  return l;
}

describe('a shared game, played by two and watched by a third', () => {
  it('runs the same frames on every page, with player 2 pressing from another computer', async () => {
    const [a, b, c] = await room(['a', null], ['b', null], ['c', null]);
    const host = await startGame(a, 0, 2);
    const guest = link(b, 1, 2);
    expect(guest.shared()).toMatchObject({ role: 'watcher', joinAs: 2 });
    guest.join();
    await run(50);
    expect(guest.shared()).toMatchObject({ role: 'guest', player: 2 });
    expect(a.games.readArcade(ITEM)?.guestPage).toBe(b.mod.arcadePage());

    const p1 = padScript(1);
    const p2 = padScript(2);
    const guestPads = new Set<number>();
    await run(4000, () => {
      host.setButtons(p1());
      const pad = p2();
      guestPads.add(pad);
      guest.setButtons(pad);
    });

    // The host played the guest's presses as player 2: every pad the guest
    // held shows up in the pads the host sent the room.
    const hostP2 = new Set(ticksOf(a, 'frames').map((t) => (unpackArcadeTick(t) as { cur: number }).cur >> 8));
    for (const pad of guestPads) expect(hostP2.has(pad), `guest pad ${pad}`).toBe(true);
    expect(ticksOf(b, 'guest').length).toBeGreaterThan(30);

    // …and everyone saw the same game.
    for (const p of [b, c]) {
      const { common, differ } = compare(a, p);
      expect(common, p.name).toBeGreaterThan(150);
      expect(differ, p.name).toEqual([]);
    }
    // Nobody fell behind for good, and nobody needed a save state.
    const hostAt = a.mod.arcadeCopyInfo(ITEM)!.next;
    for (const p of [b, c]) expect(hostAt - p.mod.arcadeCopyInfo(ITEM)!.next).toBeLessThan(6);
    expect(ticksOf(b, 'sync').length + ticksOf(c, 'sync').length).toBe(0);
  }, 60_000);

  it('player 2 can hand the pad back and take it again', async () => {
    const [a, b] = await room(['a', null], ['b', null]);
    await startGame(a, 0, 2);
    const guest = link(b, 1, 2);
    guest.join();
    await run(50);
    guest.stop();
    await run(50);
    expect(a.games.readArcade(ITEM)).toMatchObject({ guest: null, guestPage: null, guestToken: 0 });
    expect(guest.shared()).toMatchObject({ role: 'watcher', joinAs: 2, phase: 'playing' });
    guest.join();
    await run(50);
    expect(guest.shared()).toMatchObject({ role: 'guest' });
  }, 30_000);

  it('a stale guest page cannot drive player 2', async () => {
    const [a, b] = await room(['a', null], ['b', null]);
    const host = await startGame(a, 0, 2);
    host.setButtons(0);
    const m = a.games.readArcade(ITEM)!;
    // A guest tick with the wrong token: the host keeps player 2 idle.
    const forged = packArcadeTick({ type: 'guest', match: m.id, token: 1234, cur: 0xff, prev: 0, changes: 1, seq: 1 });
    a.mod.routeArcadeTick(b.lane, forged);
    await run(100);
    const p2 = ticksOf(a, 'frames').map((t) => (unpackArcadeTick(t) as { cur: number }).cur >> 8);
    expect(p2.every((pad) => pad === 0)).toBe(true);
  }, 30_000);

  it('a guest who closes the tab frees the stand; the next one plays at once', async () => {
    const [a, b, d] = await room(['a', null], ['b', null], ['d', null]);
    const host = await startGame(a, 0, 2);
    host.setButtons(0);
    const first = link(b, 1, 2);
    first.join();
    await run(300, () => first.setButtons(PAD_BIT.RIGHT));
    b.closed = true; // gone mid-press, without handing the seat back
    const next = link(d, 1, 2);
    await run(3000);
    expect(next.shared()).toMatchObject({ role: 'watcher', joinAs: null }); // still held…
    await run(4000);
    expect(a.games.readArcade(ITEM)?.guestPage).toBeNull(); // …until the host gives up on it
    expect(next.shared()).toMatchObject({ role: 'watcher', joinAs: 2 });

    next.join();
    await run(500, () => next.setButtons(PAD_BIT.LEFT));
    const p2 = ticksOf(a, 'frames').slice(-10).map((t) => (unpackArcadeTick(t) as { cur: number }).cur >> 8);
    expect(p2.every((pad) => pad === PAD_BIT.LEFT)).toBe(true);
  }, 60_000);

  it("a new guest's presses count straight away, even right after another's", async () => {
    const [a, b, d] = await room(['a', null], ['b', null], ['d', null]);
    await startGame(a, 0, 2);
    const first = link(b, 1, 2);
    first.join();
    await run(1500, () => first.setButtons(PAD_BIT.B));
    first.stop();
    const next = link(d, 1, 2);
    next.join();
    await run(300, () => next.setButtons(PAD_BIT.UP));
    const p2 = ticksOf(a, 'frames').slice(-5).map((t) => (unpackArcadeTick(t) as { cur: number }).cur >> 8);
    expect(p2.every((pad) => pad === PAD_BIT.UP)).toBe(true);
  }, 60_000);

  it('a host at the second stand plays player 2; the free stand offers player 1', async () => {
    const [a, b] = await room(['a', null], ['b', null]);
    const host = await startGame(a, 1, 2);
    expect(host.shared()).toMatchObject({ role: 'host', player: 2 });
    const other = link(b, 0, 2);
    expect(other.shared()).toMatchObject({ role: 'watcher', joinAs: 1 });
    other.join();
    await run(50);
    expect(other.shared()).toMatchObject({ role: 'guest', player: 1 });
  }, 30_000);
});

describe('joining late and staying in step', () => {
  it('a watcher who walks in mid-game continues from a save state', async () => {
    const [a] = await room(['a', null]);
    const host = await startGame(a, 0, 1);
    const p1 = padScript(3);
    await run(3000, () => host.setButtons(p1()));

    const late = await openPage('late', null);
    await run(3000, () => host.setButtons(p1()));

    expect(late.cards).toContain('JOINING…');
    expect(ticksOf(late, 'sync').length).toBeGreaterThan(0);
    const snap = late.games.readArcadeSnapshot(ITEM);
    expect(snap?.data.byteLength).toBeLessThan(40 * 1024);
    const first = Math.min(...late.hashes.keys());
    expect(first).toBeGreaterThan(150); // it never ran the game from power-on
    const { common, differ } = compare(a, late);
    expect(common).toBeGreaterThan(60);
    expect(differ).toEqual([]);
  }, 60_000);

  it('a watcher on a lossy link still shows only the right frames', async () => {
    const [a, c] = await room(['a', null], ['c', null]);
    let s = 7;
    lose = (_from, to) => to === c && ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) % 4 === 0;
    const host = await startGame(a, 0, 1);
    const p1 = padScript(4);
    await run(5000, () => host.setButtons(p1()));
    const { common, differ } = compare(a, c);
    expect(common).toBeGreaterThan(100);
    expect(differ).toEqual([]);
    expect(a.mod.arcadeCopyInfo(ITEM)!.next - c.mod.arcadeCopyInfo(ITEM)!.next).toBeLessThan(90);
  }, 60_000);

  it('a watcher whose copy is knocked off course notices and resyncs', async () => {
    const [a, c] = await room(['a', null], ['c', null]);
    const host = await startGame(a, 0, 1);
    const p1 = padScript(5);
    // Frames 300–339 reach the watcher with the wrong pads.
    rewrite = (_from, to, bytes) => {
      const t = unpackArcadeTick(bytes);
      if (to !== c || t?.type !== 'frames' || t.frame < 300 || t.frame >= 340) return bytes;
      return packArcadeTick({ ...t, cur: t.cur ^ (PAD_BIT.LEFT | PAD_BIT.A), run0: 1, run1: 0 });
    };
    await run(9000, () => host.setButtons(p1()));

    const drifted = compare(a, c).differ;
    expect(drifted.length).toBeGreaterThan(0); // the bad pads did knock it off…
    expect(ticksOf(c, 'sync').length).toBeGreaterThan(0); // …it asked for a save state…
    const after = compare(a, c, Math.max(...drifted) + 1);
    expect(after.common).toBeGreaterThan(60); // …and is back in step
    expect(after.differ).toEqual([]);
  }, 60_000);
});

describe('when the host goes', () => {
  it('ending the game clears every cabinet', async () => {
    const [a, c] = await room(['a', null], ['c', null]);
    const host = await startGame(a, 0, 1);
    await run(500);
    const attract = c.attract;
    host.stop();
    await run(50);
    expect(c.games.readArcade(ITEM)).toBeNull();
    expect(c.mod.arcadeCopyInfo(ITEM)).toBeNull();
    expect(c.attract).toBeGreaterThan(attract);
  }, 30_000);

  it('a host who closes the tab: PLAYER 1 LEFT, then the cabinet is free again', async () => {
    const [a, b] = await room(['a', null], ['b', null]);
    await startGame(a, 0, 2);
    const guest = link(b, 1, 2);
    guest.join();
    await run(500);
    a.closed = true;
    await run(5000);
    expect(b.cards.at(-1)).toBe('PLAYER 1 LEFT');
    expect(guest.shared()).toMatchObject({ phase: 'ended' });
    const attract = b.attract;
    await run(8000);
    expect(b.attract).toBeGreaterThan(attract);
    expect(guest.shared()).toBeNull();
    // Anyone can start a new game on it.
    guest.host(THWAITE);
    await run(100);
    expect(b.games.readArcade(ITEM)?.hostPage).toBe(b.mod.arcadePage());
    expect(guest.shared()).toMatchObject({ role: 'host', phase: 'playing', player: 2 });
  }, 60_000);
});

describe('watching from across the room', () => {
  it('repaints less the farther away the watcher stands; the network is the same', async () => {
    const [a, near, far] = await room(['a', null], ['near', { x: 2, z: 0 }], ['far', { x: 20, z: 0 }]);
    await startGame(a, 0, 1);
    // With nobody playing player 2 remotely the host sends a tick every
    // other frame, so a watcher repaints at most every other update.
    await run(2000);
    expect(near.hashes.size).toBeGreaterThan(50);
    expect(far.hashes.size).toBeLessThan(near.hashes.size / 4);
    expect(far.hashes.size).toBeGreaterThan(5);
    expect(compare(a, far).differ).toEqual([]);
    expect(far.sent).toEqual([]); // a watcher in step sends nothing at all
    // Walk up to it: the near rate again.
    far.viewer = { x: 1, z: 0 };
    const before = far.hashes.size;
    await run(1000);
    expect(far.hashes.size - before).toBeGreaterThan(25);
  }, 60_000);
});

describe('rooms and builds', () => {
  it("a page that goes to another room leaves its cabinet link behind", async () => {
    const [a] = await room(['a', null]);
    setRoom('room-a');
    const l = a.mod.linkArcade(ITEM, 0, 2); // the menu is up (the UI's own screen)
    l.host(THWAITE); // the ROM is still on its way…
    moveRoom(a, 'room-b'); // …when the page moves to another room
    const attract = a.attract;
    await run(200);
    expect(a.games.readArcade(ITEM)).toBeNull(); // nothing written into room B
    expect(l.shared()).toBeNull();
    l.host(THWAITE);
    l.join();
    l.stop();
    await run(200);
    expect(a.games.readArcade(ITEM)).toBeNull();
    // Room B's cabinet with the same id is the room's, not held by the link.
    expect(a.attract).toBeGreaterThan(attract);
  }, 30_000);

  it('a page that rejoins the same room picks its cabinet up again', async () => {
    const [a] = await room(['a', null]);
    setRoom('room-a');
    const l = link(a, 0, 1);
    moveRoom(a, 'room-a');
    l.host(THWAITE);
    await run(100);
    expect(a.games.readArcade(ITEM)?.hostPage).toBe(a.mod.arcadePage());
    expect(l.shared()).toMatchObject({ role: 'host', phase: 'playing' });
  }, 30_000);

  it('two cabinets never share a match id, even when they claim one at once', async () => {
    const [a, c] = await room(['a', null], ['c', null]);
    addCabinet(a, 'arcade-2');
    // Both games pick the same id before either is in the room doc.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const one = link(a, 0, 1);
    const two = a.mod.linkArcade('arcade-2', 0, 1);
    two.setUiScreen(false);
    one.host(THWAITE);
    two.host(THWAITE);
    await run(100);
    random.mockRestore();
    const m1 = c.games.readArcade(ITEM)!;
    const m2 = c.games.readArcade('arcade-2')!;
    expect(m1.id).not.toBe(m2.id); // one of them moved

    // A cabinet in another page's view of the room claimed this game's id
    // at the same moment, and started first: this game moves to a new id.
    c.games.writeArcade('arcade-3', { ...m1, host: 'someone', hostPage: 'their-page', startedAt: m1.startedAt - 1 });
    const p1 = padScript(5);
    await run(3000, () => one.setButtons(p1()));
    const moved = c.games.readArcade(ITEM)!;
    expect(moved.id).not.toBe(m1.id);
    expect(moved.id).not.toBe(m2.id);
    expect(c.games.readArcade('arcade-2')!.id).toBe(m2.id); // no clash there
    // The watcher followed it to the new id, and shows the same game.
    expect(c.mod.arcadeCopyInfo(ITEM)?.started).toBe(true);
    const { common, differ } = compare(a, c);
    expect(common).toBeGreaterThan(60);
    expect(differ).toEqual([]);
  }, 60_000);

  it("a game this build doesn't have clears the last game off the cabinet", async () => {
    const [a, c] = await room(['a', null], ['c', null]);
    await startGame(a, 0, 1);
    await run(500);
    expect(c.mod.arcadeCopyInfo(ITEM)?.started).toBe(true);
    const m = c.games.readArcade(ITEM)!;
    const attract = c.attract;
    c.games.writeArcade(ITEM, {
      ...m, id: (m.id % 65535) + 1, game: 'from-a-newer-build', host: 'someone', hostPage: 'their-page',
    });
    await run(100);
    expect(c.mod.arcadeCopyInfo(ITEM)).toBeNull();
    expect(c.attract).toBeGreaterThan(attract);
  }, 30_000);
});
