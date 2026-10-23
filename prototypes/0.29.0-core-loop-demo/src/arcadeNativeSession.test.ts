/**
 * 🕹🕹 A cabinet's own game across a room, end to end: several pages, each
 * with its own copy of the session, gamesDoc and room doc (synced as Yjs
 * updates), passing arcade ticks between them, some lost. Every page's
 * cabinet screen records the game state it paints, by frame, and pages
 * must agree on every frame they both painted: the host, three guests, a
 * watcher who walks in late (a save state), and a guest who closes the tab.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCADE_WIRE_NATIVE, packArcadeTick, pipe, unpackArcadeTick } from './arcadeNet';
import type { ArcadeLink } from './arcadeNesSession';
import { LR_REV, type LrState } from './games/lanternRoad';
import { newNativeMatch } from './games/nativeArcade';

type SessionModule = typeof import('./arcadeNativeSession');
type GamesModule = typeof import('./games/gamesDoc');
type CasinoModule = typeof import('./casinoDoc');
type ArcadeDocModule = typeof import('./arcadeDoc');
type YModule = typeof import('yjs');

const ITEM = 'arcade-wide-1';
const LANTERN_ROAD = { id: 'lantern-road', title: 'LANTERN ROAD', blurb: '', controls: '' };

interface Page {
  name: string;
  lane: string;
  mod: SessionModule;
  games: GamesModule;
  casino: CasinoModule;
  arcade: ArcadeDocModule;
  /** This page's player id. */
  player: string;
  Y: YModule;
  doc: InstanceType<YModule['Doc']>;
  /** Painted frames: the frame number each shows → the state's JSON. */
  painted: Map<number, string>;
  titles: string[];
  released: number;
  outbox: Uint8Array[];
  sent: Uint8Array[];
  closed: boolean;
}

let lose: (from: Page, to: Page, bytes: Uint8Array) => boolean = () => false;
let pages: Page[] = [];

async function openPage(name: string): Promise<Page> {
  vi.resetModules();
  const Y = await import('yjs');
  const casino = await import('./casinoDoc');
  const games = await import('./games/gamesDoc');
  const mod = await import('./arcadeNativeSession');
  const arcade = await import('./arcadeDoc');
  const player = (await import('./identity')).getPlayerId();
  const doc = new Y.Doc();
  for (const other of pages) if (!other.closed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(other.doc), 'room');
  casino.bindCasinoDoc(doc);
  games.bindGamesDoc(doc);
  arcade.bindArcadeDoc(doc);
  const page: Page = {
    name, lane: `lane-${name}`, mod, games, casino, arcade, player, Y, doc,
    painted: new Map(), titles: [], released: 0, outbox: [], sent: [], closed: false,
  };
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'room' || page.closed) return;
    for (const other of pages) if (other !== page && !other.closed) other.Y.applyUpdate(other.doc, update, 'room');
  });
  mod.setNativeArcadeSender((buf) => {
    page.outbox.push(buf.slice());
    page.sent.push(buf.slice());
  });
  mod.setNativeCabinetGameReader((id) => (id === ITEM ? 'lantern-road' : null));
  mod.registerNativeArcadeVisual(ITEM, {
    painter: {
      drawFrame: () => undefined,
      drawMenu: () => undefined,
      drawCredits: () => undefined,
      drawCard: () => undefined,
      drawAttract: () => undefined,
      drawWith: () => {
        const info = mod.nativeArcadeCopyInfo(ITEM);
        if (info?.started && info.state) {
          const s = info.state as LrState;
          page.painted.set(s.frame, JSON.stringify(s));
        } else {
          page.titles.push('title');
        }
      },
    },
    present: () => undefined,
    showAttract: () => page.released++,
    setPictureLines: () => undefined,
  }, { x: 0, z: 0 });
  pages.push(page);
  return page;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function run(ms: number, each?: (step: number) => void): Promise<void> {
  const steps = Math.round(ms / (1000 / 60));
  for (let i = 0; i < steps; i++) {
    vi.setSystemTime(Date.now() + 1000 / 60);
    each?.(i);
    for (const p of pages) if (!p.closed) p.mod.nativeArcadeFrame(1 / 60, { x: 0, z: 1 });
    for (const from of pages) {
      for (const bytes of from.outbox) {
        for (const to of pages) {
          if (to === from || to.closed || from.closed || lose(from, to, bytes)) continue;
          to.mod.routeNativeArcadeTick(from.lane, bytes);
        }
      }
      from.outbox.length = 0;
    }
    await flush();
    await flush();
  }
}

function link(page: Page, seat: number | null): ArcadeLink {
  const l = page.mod.linkNativeArcade(ITEM, seat);
  l.setUiScreen(false);
  return l;
}

/** Each pad held 4–30 frames: the D-pad, A and B, never Select/Start. */
function padScript(seed: number) {
  let s = seed >>> 0;
  let cur = 0;
  let left = 0;
  return () => {
    if (left-- <= 0) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      cur = (s >>> 8) & 0xf3;
      // Mostly forward, so the road goes by.
      if ((s >>> 4) & 1) cur = (cur | 0x80) & ~0x40;
      left = 4 + ((s >>> 20) % 27);
    }
    return cur;
  };
}

function compare(a: Page, b: Page): { common: number; differ: number[] } {
  let common = 0;
  const differ: number[] = [];
  for (const [frame, json] of b.painted) {
    if (!a.painted.has(frame)) continue;
    common++;
    if (a.painted.get(frame) !== json) differ.push(frame);
  }
  return { common, differ };
}

const stateOf = (p: Page) => p.mod.nativeArcadeCopyInfo(ITEM)?.state as LrState | undefined;

async function room(...names: string[]): Promise<Page[]> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
  const out: Page[] = [];
  for (const name of names) out.push(await openPage(name));
  return out;
}

afterEach(() => {
  pages = [];
  lose = () => false;
  vi.useRealTimers();
});

describe('the double-wide cabinet\'s own game, four players', () => {
  it('runs the same frames on every page with four players on four computers', async () => {
    const [a, b, c, d, w] = await room('a', 'b', 'c', 'd', 'w');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    expect(host.shared()).toMatchObject({ role: 'host', player: 1 });
    await run(100);
    const guests = [link(b, 1), link(c, 2), link(d, 3)];
    expect(guests[0]!.shared()).toMatchObject({ role: 'watcher', joinAs: 2 });
    for (const g of guests) g.join();
    await run(200);
    guests.forEach((g, i) => expect(g.shared()).toMatchObject({ role: 'guest', player: i + 2 }));
    const watcher = link(w, null);
    expect(watcher.shared()).toMatchObject({ role: 'watcher', joinAs: null });

    const scripts = [1, 2, 3, 4].map(padScript);
    await run(6000, () => {
      host.setButtons(scripts[0]!());
      guests.forEach((g, i) => g.setButtons(scripts[i + 1]!()));
    });
    // Everyone is on the road, in every copy.
    for (const p of [a, b, c, d, w]) expect(stateOf(p)!.players.map((pl) => pl.on)).toEqual([true, true, true, true]);
    // And every page painted the same game.
    for (const p of [b, c, d, w]) {
      const { common, differ } = compare(a, p);
      expect(common).toBeGreaterThan(200);
      expect(differ).toEqual([]);
    }
    // The guests' presses made it into the game: they walked off the start.
    expect(stateOf(a)!.cam).toBeGreaterThan(0);
    // Only the native wire was spoken.
    for (const bytes of a.sent) expect(unpackArcadeTick(bytes)).toBeNull();
    expect(a.sent.some((bytes) => unpackArcadeTick(bytes, ARCADE_WIRE_NATIVE)?.type === 'frames')).toBe(true);
  });

  it('keeps in step when ticks go missing', async () => {
    const [a, b, c] = await room('a', 'b', 'c');
    let n = 0;
    lose = () => (n++ % 5) === 0; // one in five
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    const guest = link(b, 1);
    guest.join();
    await run(200);
    const s1 = padScript(7);
    const s2 = padScript(8);
    await run(5000, () => {
      host.setButtons(s1());
      guest.setButtons(s2());
    });
    for (const p of [b, c]) {
      const { common, differ } = compare(a, p);
      expect(common).toBeGreaterThan(100);
      expect(differ).toEqual([]);
    }
  });

  it('brings a page that walks in late up to date from a save state', async () => {
    const [a, b] = await room('a', 'b');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    const guest = link(b, 2);
    await run(100);
    guest.join();
    const s1 = padScript(3);
    const s2 = padScript(4);
    await run(3000, () => {
      host.setButtons(s1());
      guest.setButtons(s2());
    });
    const late = await openPage('late');
    await run(3000, () => {
      host.setButtons(s1());
      guest.setButtons(s2());
    });
    expect(a.games.readNativeSnapshot(ITEM)).not.toBeNull();
    const info = late.mod.nativeArcadeCopyInfo(ITEM);
    expect(info?.started).toBe(true);
    const { common, differ } = compare(a, late);
    expect(common).toBeGreaterThan(50);
    expect(differ).toEqual([]);
  });

  it('frees the seat of a guest who closes the tab, and their player leaves the road', async () => {
    const [a, b, c] = await room('a', 'b', 'c');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    const guest = link(b, 1);
    guest.join();
    await run(500);
    expect(stateOf(a)!.players[1]!.on).toBe(true);
    b.closed = true;
    await run(8000);
    expect(a.games.readNativeSeat(ITEM, 1)).toBeNull();
    expect(stateOf(a)!.players[1]!.on).toBe(false);
    expect(stateOf(c)!.players[1]!.on).toBe(false);
    // The stand is free for the next player.
    const next = link(c, 1);
    expect(next.shared()).toMatchObject({ role: 'watcher', joinAs: 2 });
  });

  it('a guest hands the seat back, and the host ending the game clears the cabinet', async () => {
    const [a, b] = await room('a', 'b');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    const guest = link(b, 3);
    guest.join();
    await run(300);
    expect(guest.shared()).toMatchObject({ role: 'guest', player: 4 });
    guest.stop();
    await run(100);
    expect(guest.shared()).toMatchObject({ role: 'watcher', joinAs: 4 });
    host.release();
    await run(100);
    expect(a.games.readNativeArcade(ITEM)).toBeNull();
    expect(guest.shared()).toBeNull();
    // Back to the game's own title on the cabinet.
    expect(b.titles.length).toBeGreaterThan(0);
  });

  it('cannot take a seat somebody holds, nor the host\'s', async () => {
    const [a, b, c] = await room('a', 'b', 'c');
    const host = link(a, 1);
    host.host(LANTERN_ROAD);
    await run(100);
    expect(host.shared()).toMatchObject({ player: 2 });
    const onHost = link(b, 1);
    expect(onHost.shared()).toMatchObject({ role: 'watcher', joinAs: null });
    onHost.join();
    const first = link(b, 0);
    first.join();
    await run(100);
    const second = link(c, 0);
    expect(second.shared()).toMatchObject({ role: 'watcher', joinAs: null });
    second.join();
    await run(100);
    expect(a.games.readNativeSeat(ITEM, 0)?.page).toBe(b.mod.nativeArcadePage());
  });

  it('hands the screen back once the cabinet\'s game is something else', async () => {
    const [a] = await room('a');
    await run(50);
    expect(a.titles.length).toBeGreaterThan(0);
    a.mod.setNativeCabinetGameReader(() => null);
    await run(50);
    expect(a.released).toBe(1);
  });

  it('hands the screen back when a running game ends as the cabinet\'s game changes', async () => {
    const [a, b] = await room('a', 'b');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(300);
    expect(b.painted.size).toBeGreaterThan(0);
    // The owner puts another game on: the match ends in the same moment.
    for (const p of [a, b]) p.mod.setNativeCabinetGameReader(() => null);
    a.games.writeNativeArcade(ITEM, null);
    await run(50);
    expect(a.released).toBe(1);
    expect(b.released).toBe(1);
  });

  it('lets go of a match its host left behind once the cabinet\'s game changes', async () => {
    const [a, b] = await room('a', 'b');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(300);
    // The host closes the tab: its record stays in the doc, nobody runs it.
    a.closed = true;
    await run(13000);
    expect(b.games.readNativeArcade(ITEM)).not.toBeNull();
    expect(b.mod.nativeArcadeCopyInfo(ITEM)).not.toBeNull();
    // The owner puts another game on (the record is still there).
    b.mod.setNativeCabinetGameReader(() => null);
    await run(50);
    expect(b.mod.nativeArcadeCopyInfo(ITEM)).toBeNull();
    expect(b.released).toBe(1);
  });

  it('a guest keeps playing when its match moves to a fresh id', async () => {
    const [a, b] = await room('a', 'b');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    const guest = link(b, 1);
    guest.join();
    const pads = padScript(9);
    await run(3000, () => guest.setButtons(pads()));
    // Last heard before the move: walking left.
    await run(500, () => guest.setButtons(0x40));
    // Another cabinet claimed the same id first: this match must move.
    const m = a.games.readNativeArcade(ITEM)!;
    a.games.writeNativeArcade('arcade-wide-2', { ...m, hostPage: 'elsewhere', startedAt: m.startedAt - 1000 });
    guest.setButtons(0);
    await run(500);
    expect(a.games.readNativeArcade(ITEM)!.id).not.toBe(m.id);
    // Player 2 walks right: the host hears the guest's restarted ticks.
    const from = stateOf(a)!.players[1]!.x;
    let furthest = from;
    await run(2000, () => {
      guest.setButtons(0x80);
      furthest = Math.max(furthest, stateOf(a)!.players[1]!.x);
    });
    expect(furthest).toBeGreaterThan(from);
    expect(guest.shared()).toMatchObject({ role: 'guest', player: 2 });
  });

  it('keeps two guests apart even when their seats draw the same random token', async () => {
    const [a, b, c] = await room('a', 'b', 'c');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    const g1 = link(b, 1);
    const g2 = link(c, 3);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    g1.join();
    g2.join();
    random.mockRestore();
    const t1 = a.games.readNativeSeat(ITEM, 1)!.token;
    const t3 = a.games.readNativeSeat(ITEM, 3)!.token;
    expect(t1).not.toBe(t3);
    // Player 4 walks right; player 2 stands still.
    await run(300);
    const from = stateOf(a)!.players[3]!.x;
    let furthest = from;
    await run(8000, () => {
      g1.setButtons(0);
      g2.setButtons(0x80);
      furthest = Math.max(furthest, stateOf(a)!.players[3]!.x);
    });
    // Player 4's presses drove player 4, and both still hold their seats
    // (each one's ticks kept their own alive).
    expect(furthest).toBeGreaterThan(from);
    expect(g1.shared()).toMatchObject({ role: 'guest', player: 2 });
    expect(g2.shared()).toMatchObject({ role: 'guest', player: 4 });
  });

  it('tells a page walking up which stands are free, its own, or taken', async () => {
    const [a, b, c] = await room('a', 'b', 'c');
    expect(c.mod.nativeSeatStatus(ITEM)).toEqual(['free', 'free', 'free', 'free']);
    const host = link(a, 1);
    host.host(LANTERN_ROAD);
    await run(100);
    link(b, 3).join();
    await run(100);
    expect(a.mod.nativeSeatStatus(ITEM)).toEqual(['free', 'mine', 'free', 'taken']);
    expect(b.mod.nativeSeatStatus(ITEM)).toEqual(['free', 'taken', 'free', 'mine']);
    expect(c.mod.nativeSeatStatus(ITEM)).toEqual(['free', 'taken', 'free', 'taken']);
    // The host's page goes for good: every stand is free again.
    a.closed = true;
    await run(13000);
    expect(c.mod.nativeSeatStatus(ITEM)).toEqual(['free', 'free', 'free', 'free']);
  });

  it('shrugs off a save state that is not one, and takes the next', async () => {
    const [a] = await room('a');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    const pads = padScript(5);
    await run(1000, () => host.setButtons(pads()));
    // The host hears no one asking: only a broken save is in the doc.
    lose = (_from, to, bytes) => to === a && unpackArcadeTick(bytes, ARCADE_WIRE_NATIVE)?.type === 'sync';
    const late = await openPage('late');
    await run(300, () => host.setButtons(pads()));
    expect(late.mod.nativeArcadeCopyInfo(ITEM)?.started).toBe(false);
    const m = a.games.readNativeArcade(ITEM)!;
    const next = (a.mod.nativeArcadeCopyInfo(ITEM)!.next - 2) & 0xffff;
    const data = await pipe(new TextEncoder().encode('{ not a save'), new CompressionStream('deflate'));
    a.games.writeNativeSnapshot(ITEM, { kind: 'arcade-native-snapshot', id: m.id, next, data });
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => void rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      await run(300, () => host.setButtons(pads()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
    expect(late.mod.nativeArcadeCopyInfo(ITEM)?.started).toBe(false);
    // The host hears the asks again: a real save, and the late page plays.
    lose = () => false;
    await run(3000, () => host.setButtons(pads()));
    expect(late.mod.nativeArcadeCopyInfo(ITEM)?.started).toBe(true);
  });

  it('never follows, or seats anyone in, a match on another revision of the game', async () => {
    const [a, b] = await room('a', 'b');
    // A tab from before an update hosts: its record names another revision.
    for (const game of ['lantern-road', `lantern-road@${LR_REV - 1}`]) {
      a.games.writeNativeArcade(ITEM, newNativeMatch({
        id: 77, game, host: 'old-player', hostPage: 'old-page', hostSeat: 0, now: Date.now(),
      }));
      await run(100);
      for (const p of [a, b]) {
        expect(p.mod.nativeArcadeCopyInfo(ITEM)).toBeNull();
        expect(p.mod.nativeSeatStatus(ITEM)).toEqual(['free', 'free', 'free', 'free']);
      }
      link(b, 2).join();
      await run(50);
      expect(b.games.readNativeSeat(ITEM, 2)).toBeNull();
    }
    // This page's own match names its revision, so an older tab won't follow it.
    link(a, 0).host(LANTERN_ROAD);
    await run(100);
    expect(b.games.readNativeArcade(ITEM)!.game).toBe(`lantern-road@${LR_REV}`);
    expect(b.mod.nativeArcadeCopyInfo(ITEM)?.role).toBe('follow');
  });

  it('enters a player\'s score on the cabinet\'s high scores as they step away, the rest as the game ends', async () => {
    const [a, b] = await room('a', 'b');
    a.doc.getMap('players').set(b.player, { name: 'Bob' });
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    const guest = link(b, 2);
    guest.join();
    await run(300);
    // Points the host's copy (the reference) has them on.
    const s = stateOf(a)!;
    s.players[0]!.score = 1200;
    s.players[2]!.score = 700;
    await run(50);
    expect(a.arcade.readHighScores(ITEM, 'lantern-road')).toEqual([]);
    guest.stop(); // Bob steps away: his player leaves the road half a second later
    await run(700);
    expect(b.arcade.readHighScores(ITEM, 'lantern-road').map((l) => [l.name, l.score])).toEqual([['Bob', 700]]);
    host.stop();
    await run(50);
    const table = b.arcade.readHighScores(ITEM, 'lantern-road');
    expect(table.map((l) => l.score)).toEqual([1200, 700]);
    expect(table[0]!.name).toBe(a.player.slice(0, 8)); // no name in the room: their id's start
    expect(new Set(table.map((l) => l.run)).size).toBe(2);
  });

  it('enters the goes still being played every so often, so a host closing the tab loses little', async () => {
    const [a] = await room('a');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(100);
    stateOf(a)!.players[0]!.score = 950;
    await run(16000);
    expect(a.arcade.readHighScores(ITEM, 'lantern-road').map((l) => l.score)).toEqual([950]);
    // The same go scoring more replaces its line rather than adding one.
    stateOf(a)!.players[0]!.score = 2500;
    await run(16000);
    expect(a.arcade.readHighScores(ITEM, 'lantern-road').map((l) => l.score)).toEqual([2500]);
  });

  it('ignores a NES-wire tick, even one with the same match id', async () => {
    const [a, b] = await room('a', 'b');
    const host = link(a, 0);
    host.host(LANTERN_ROAD);
    await run(200);
    const id = a.games.readNativeArcade(ITEM)!.id;
    const before = b.mod.nativeArcadeCopyInfo(ITEM)!.next;
    // A forged NES frames tick far ahead: on the wrong wire, never heard.
    b.mod.routeNativeArcadeTick('lane-x', packArcadeTick({ type: 'frames', match: id, frame: 4000, cur: 0xffff, run0: 255, prev: 0, run1: 0, check: 0 }));
    await run(50);
    expect(b.mod.nativeArcadeCopyInfo(ITEM)!.next).toBeGreaterThan(before);
    expect(b.mod.nativeArcadeCopyInfo(ITEM)!.started).toBe(true);
  });
});
