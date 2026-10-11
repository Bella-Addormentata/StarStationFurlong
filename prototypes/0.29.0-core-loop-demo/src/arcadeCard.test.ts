/**
 * 🕹️⚙️ The arcade cabinet's card: what anyone reads on it (the game, its
 * author and license, who holds each player, the controls), what only the
 * room's owner can change (the game it offers, reset), and the dialog's
 * open/close in a fake DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  arcadeCardHtml, arcadeCardModel, cardAction, closeArcadeCardFor, nextPinned, openArcadeCard, pinnedGame, showArcadeCard,
} from './arcadeCard';
import { ARCADE_GAMES } from './arcadeLibrary';
import { newMatch, withGuest } from './games/arcade';
import { bindGamesDoc, readArcade, readArcadeSettings, writeArcade, writeArcadeSettings } from './games/gamesDoc';

const ITEM = 'arcade-1';
const ME = 'me-player';
let doc: Y.Doc;

const name = (id: string, display: string) => doc.getMap('players').set(id, { name: display });
const start = (hostSeat: 0 | 1, host = 'ada-id') => {
  const m = newMatch({ game: ARCADE_GAMES[0].id, host, hostPage: 'page-a', hostSeat, now: 1 });
  writeArcade(ITEM, m);
  return m;
};

beforeEach(() => {
  doc = new Y.Doc();
  bindGamesDoc(doc);
  name('ada-id', 'Ada');
  name('bo-id', 'Bo');
});

describe('what the card says', () => {
  it('to a visitor at an idle cabinet: every game, read-only, nothing to reset', () => {
    const model = arcadeCardModel(ITEM, 1, false, ME);
    expect(model.title).toBe('⚙️ ARCADE CABINET');
    expect(model.role).toBe('THE OWNER SETS THIS CABINET · ANYONE CAN LOOK');
    expect(model.now).toBeNull();
    expect(model.pinned).toBeNull();
    expect(model.offered).toEqual(ARCADE_GAMES);
    expect(model.canReset).toBe(false);
    const html = arcadeCardHtml(model);
    expect(html).toContain('NOTHING · STEP UP AND PRESS ENTER TO PLAY');
    expect(html).toContain('EVERY BUNDLED GAME');
    for (const g of ARCADE_GAMES) expect(html).toContain(g.title);
    expect(html).toContain('ARROWS OR WASD MOVE');
    // No owner controls: only the close button acts.
    expect(html.match(/data-act="/g)).toHaveLength(1);
  });

  it('to the owner: "you run this cabinet", the game choice, and reset once a game runs', () => {
    expect(arcadeCardModel(ITEM, 2, true, ME)).toMatchObject({
      title: '⚙️ 2-PLAYER ARCADE CABINET', role: 'YOU RUN THIS CABINET', canReset: false,
    });
    start(0);
    const model = arcadeCardModel(ITEM, 2, true, ME);
    expect(model.canReset).toBe(true);
    const html = arcadeCardHtml(model);
    expect(html).toContain('data-act="game"');
    expect(html).toMatch(/data-act="reset" +style/); // enabled
  });

  it('names the game running, its author and license, and who holds each player', () => {
    start(0);
    const game = ARCADE_GAMES[0];
    const model = arcadeCardModel(ITEM, 2, false, ME);
    expect(model.now?.game).toBe(game);
    expect(model.now?.players).toEqual([
      { player: 1, who: 'ADA' },
      { player: 2, who: 'OPEN · STEP UP TO THE RIGHT STAND' },
    ]);
    const html = arcadeCardHtml(model);
    expect(html).toContain(game.author.toUpperCase());
    expect(html).toContain('GPL-3.0 OR LATER');

    // Player 2 taken by this page's player.
    writeArcade(ITEM, withGuest(readArcade(ITEM)!, ME, 'page-me')!);
    expect(arcadeCardModel(ITEM, 2, false, ME).now?.players).toEqual([
      { player: 1, who: 'ADA' },
      { player: 2, who: 'YOU' },
    ]);
  });

  it('knows which stand is open when the host plays player 2', () => {
    start(1, 'bo-id');
    expect(arcadeCardModel(ITEM, 2, false, ME).now?.players).toEqual([
      { player: 1, who: 'OPEN · STEP UP TO THE LEFT STAND' },
      { player: 2, who: 'BO' },
    ]);
  });

  it("on a one-player cabinet, player 2 is a second gamepad on player 1's computer", () => {
    start(0);
    expect(arcadeCardModel(ITEM, 1, false, ME).now?.players[1]).toEqual({
      player: 2, who: "A SECOND GAMEPAD ON PLAYER 1'S COMPUTER",
    });
  });

  it('a game from a newer version is still a game: named as such, with its players, and the owner can end it', () => {
    writeArcade(ITEM, { ...newMatch({ game: 'from-a-newer-build', host: 'ada-id', hostPage: 'page-a', hostSeat: 0, now: 1 }) });
    const model = arcadeCardModel(ITEM, 2, true, ME);
    expect(model.now).toEqual({
      game: null,
      players: [{ player: 1, who: 'ADA' }, { player: 2, who: 'OPEN · STEP UP TO THE RIGHT STAND' }],
    });
    expect(model.canReset).toBe(true);
    const html = arcadeCardHtml(model);
    expect(html).toContain('A GAME FROM A NEWER VERSION');
    expect(html).not.toContain('NOTHING · STEP UP');
    expect(html).toMatch(/data-act="reset" +style/); // enabled
  });

  it("escapes a player's chosen name", () => {
    name('ada-id', '<img src=x onerror=alert(1)>');
    start(0);
    const html = arcadeCardHtml(arcadeCardModel(ITEM, 2, false, ME));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;IMG SRC=X ONERROR=ALERT(1)&gt;');
  });
});

describe('what the owner can change', () => {
  it('cycles the game: every game, then each bundled game, then every game again', () => {
    const seen: Array<string | null> = [];
    let cur: string | null = null;
    for (let i = 0; i <= ARCADE_GAMES.length; i++) seen.push((cur = nextPinned(cur)));
    expect(seen).toEqual([...ARCADE_GAMES.map((g) => g.id), null]);
    expect(nextPinned('a-game-this-build-lacks')).toBe(ARCADE_GAMES[0].id);
    expect(pinnedGame('a-game-this-build-lacks')).toBeNull();
  });

  it('pins a game for the owner only; the card then offers just that one', () => {
    expect(cardAction(ITEM, 'game', false)).toBeNull();
    expect(readArcadeSettings(ITEM)).toBeNull();
    cardAction(ITEM, 'game', true);
    expect(readArcadeSettings(ITEM)).toEqual({ kind: 'arcade-settings', game: ARCADE_GAMES[0].id });
    const model = arcadeCardModel(ITEM, 1, false, ME);
    expect(model.pinned).toBe(ARCADE_GAMES[0]);
    expect(model.offered).toEqual([ARCADE_GAMES[0]]);
  });

  it('resets: the owner ends the game for everyone; a visitor cannot', () => {
    start(0);
    expect(cardAction(ITEM, 'reset', false)).toBeNull();
    expect(readArcade(ITEM)).not.toBeNull();
    expect(cardAction(ITEM, 'reset', true)).toBe('THE GAME ENDED · THE CABINET IS FREE');
    expect(readArcade(ITEM)).toBeNull();
    expect(cardAction(ITEM, 'reset', true)).toBeNull(); // nothing left to end
  });

  it('keeps its settings across reset; removing the cabinet drops them', () => {
    writeArcadeSettings(ITEM, { kind: 'arcade-settings', game: ARCADE_GAMES[1].id });
    start(0);
    cardAction(ITEM, 'reset', true);
    expect(readArcadeSettings(ITEM)?.game).toBe(ARCADE_GAMES[1].id);
    writeArcadeSettings(ITEM, null);
    expect(readArcadeSettings(ITEM)).toBeNull();
  });
});

describe('the dialog', () => {
  type Handler = (e: unknown) => void;
  interface Fake {
    id: string;
    innerHTML: string;
    style: { cssText: string };
    children: Fake[];
    handlers: Map<string, Handler[]>;
    removed: boolean;
    setAttribute: () => void;
    addEventListener: (type: string, fn: Handler) => void;
    appendChild: (el: Fake) => void;
    remove: () => void;
    querySelector: () => null;
    contains: () => boolean;
  }
  const fake = (): Fake => {
    const el: Fake = {
      id: '', innerHTML: '', style: { cssText: '' }, children: [], handlers: new Map(), removed: false,
      setAttribute: () => undefined,
      addEventListener: (type, fn) => el.handlers.set(type, [...(el.handlers.get(type) ?? []), fn]),
      appendChild: (child) => void el.children.push(child),
      remove: () => void (el.removed = true),
      querySelector: () => null,
      contains: () => false,
    };
    return el;
  };
  const fire = (el: Fake, type: string, e: Record<string, unknown>) => {
    for (const fn of el.handlers.get(type) ?? []) fn({ stopPropagation: vi.fn(), preventDefault: vi.fn(), ...e });
  };
  const press = (el: Fake, act: string) => fire(el, 'click', { target: { closest: () => ({ dataset: { act } }) } });

  /** An Esc pressed with focus on `target` (the page's body unless given). */
  const esc = (target?: { tagName: string }): Event => {
    const e = new Event('keydown', { cancelable: true });
    Object.defineProperty(e, 'key', { value: 'Escape' });
    if (target) Object.defineProperty(e, 'target', { value: target });
    return e;
  };

  let win: EventTarget;
  beforeEach(() => {
    win = new EventTarget();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', { createElement: fake });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { __ssfRoomId?: string }).__ssfRoomId;
  });

  it('opens in the host, follows the room doc, and acts for the owner', () => {
    const host = fake();
    const card = openArcadeCard(host as unknown as HTMLElement, { itemId: ITEM, seats: 2, isOwner: () => true }, 'fixed');
    const el = card.el as unknown as Fake;
    expect(host.children).toEqual([el]);
    expect(el.style.cssText).toContain('position:fixed');
    expect(el.innerHTML).toContain('YOU RUN THIS CABINET');
    expect(el.innerHTML).toContain('NOTHING · STEP UP');

    start(0); // someone starts a game: the open card shows it
    expect(el.innerHTML).toContain(ARCADE_GAMES[0].title);
    press(el, 'reset');
    expect(readArcade(ITEM)).toBeNull();
    expect(el.innerHTML).toContain('THE GAME ENDED · THE CABINET IS FREE');
    start(0); // someone starts another: the notice no longer holds
    expect(el.innerHTML).not.toContain('THE GAME ENDED');
    expect(el.innerHTML).toContain('PLAYER 1 · ADA');
    card.close();
  });

  it('keeps up with a renamed player and with who may edit the room', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      start(0);
      let owner = false;
      const card = openArcadeCard(fake() as unknown as HTMLElement, { itemId: ITEM, seats: 2, isOwner: () => owner }, 'fixed');
      const el = card.el as unknown as Fake;
      expect(el.innerHTML).toContain('PLAYER 1 · ADA');
      name('ada-id', 'Ada Lovelace'); // the players map, not the games map
      owner = true; // the deed changed hands
      vi.advanceTimersByTime(1000);
      expect(el.innerHTML).toContain('PLAYER 1 · ADA LOVELACE');
      expect(el.innerHTML).toContain('YOU RUN THIS CABINET');
      card.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on ✕ or Esc, and stops following the doc', () => {
    for (const how of ['x', 'esc'] as const) {
      const onClose = vi.fn();
      const card = openArcadeCard(fake() as unknown as HTMLElement, { itemId: ITEM, seats: 1, isOwner: () => false, onClose }, 'absolute');
      const el = card.el as unknown as Fake;
      if (how === 'x') press(el, 'close');
      else win.dispatchEvent(esc());
      expect(el.removed).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      const before = el.innerHTML;
      start(0);
      expect(el.innerHTML).toBe(before);
      writeArcade(ITEM, null);
    }
  });

  it('Esc closes it wherever focus went, before the cabinet or the room sees the key', () => {
    const card = openArcadeCard(fake() as unknown as HTMLElement, { itemId: ITEM, seats: 1, isOwner: () => true }, 'fixed');
    // The cabinet's or the room view's own Esc, on window too. Node's
    // EventTarget has no capture phase and runs listeners in the order they
    // were added, so this one goes in after the card's.
    const behind = vi.fn();
    win.addEventListener('keydown', behind);
    const el = card.el as unknown as Fake;

    // Typing in the chat: that field keeps its Esc.
    const typing = esc({ tagName: 'INPUT' });
    win.dispatchEvent(typing);
    expect(el.removed).toBe(false);
    expect(behind).toHaveBeenCalledTimes(1);

    // Focus fell to the page (Tab past the last button, or a RESET that
    // re-rendered disabled): Esc still closes the card, and only the card.
    const first = esc();
    win.dispatchEvent(first);
    expect(el.removed).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(behind).toHaveBeenCalledTimes(1);

    // Closed: the next Esc is the cabinet's again.
    const next = esc();
    win.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    expect(behind).toHaveBeenCalledTimes(2);
  });

  it('keeps every key, Tab included, so Tab walks its buttons instead of opening the phone', () => {
    const card = openArcadeCard(fake() as unknown as HTMLElement, { itemId: ITEM, seats: 1, isOwner: () => true }, 'fixed');
    for (const key of ['Tab', 'Enter', 'ArrowDown']) {
      const e = { key, stopPropagation: vi.fn(), preventDefault: vi.fn() };
      for (const fn of (card.el as unknown as Fake).handlers.get('keydown') ?? []) fn(e);
      expect(e.stopPropagation).toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled(); // the browser moves focus
    }
    card.close();
  });

  it('closes when the page moves to another room', () => {
    (globalThis as { __ssfRoomId?: string }).__ssfRoomId = 'room-a';
    const card = openArcadeCard(fake() as unknown as HTMLElement, { itemId: ITEM, seats: 1, isOwner: () => true }, 'fixed');
    (globalThis as { __ssfRoomId?: string }).__ssfRoomId = 'room-b';
    bindGamesDoc(new Y.Doc()); // the new room's doc
    expect((card.el as unknown as Fake).removed).toBe(true);
  });

  it('over the room view: one card at a time, closed for its cabinet or for any other ⚙️ card', () => {
    const body = fake();
    vi.stubGlobal('document', { createElement: fake, body });
    showArcadeCard({ itemId: ITEM, seats: 1, isOwner: () => false });
    showArcadeCard({ itemId: 'arcade-2', seats: 1, isOwner: () => false });
    const [first, second] = body.children;
    expect(first.removed).toBe(true); // the second cabinet's card replaced it
    closeArcadeCardFor(ITEM);
    expect(second.removed).toBe(false); // not that cabinet's card
    closeArcadeCardFor();
    expect(second.removed).toBe(true); // another game's card opened
  });

  it("a visitor's presses change nothing", () => {
    start(0);
    const card = openArcadeCard(fake() as unknown as HTMLElement, { itemId: ITEM, seats: 1, isOwner: () => false }, 'fixed');
    press(card.el as unknown as Fake, 'reset');
    press(card.el as unknown as Fake, 'game');
    expect(readArcade(ITEM)).not.toBeNull();
    expect(readArcadeSettings(ITEM)).toBeNull();
    card.close();
  });
});
