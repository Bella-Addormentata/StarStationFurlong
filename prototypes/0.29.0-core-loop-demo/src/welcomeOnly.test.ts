import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  WELCOME_FIRST_WAIT_MS,
  WELCOME_PENDING_KEY,
  WELCOME_SEEK_CAP_MS,
  bootRoute,
  bootYields,
  clearWelcomePending,
  markWelcomePending,
  recoverLostLink,
  seekWelcome,
  seekingWelcome,
  welcomeArrivedLine,
  welcomeMarked,
  welcomeNodeLostLine,
  welcomePassAddedLine,
  welcomePassToKeep,
  welcomeRecordWithHeld,
  welcomeRetryLine,
  welcomeSeekDelayMs,
  welcomeStateHere,
  welcomeStillWaitingLine,
  welcomeWaitingLine,
} from './welcomeOnly';
import type { MarkStore, PassCodec, WelcomeFacts, WelcomeSeekDeps } from './welcomeOnly';

const WELCOME = 'home-aaaaaaaaaaaa';
const HOME = 'home-bbbbbbbbbbbb';
const OTHER = 'home-cccccccccccc';

function memoryStore(): MarkStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const throwingStore: MarkStore = {
  getItem: () => {
    throw new Error('privacy mode');
  },
  setItem: () => {
    throw new Error('privacy mode');
  },
  removeItem: () => {
    throw new Error('privacy mode');
  },
};

const facts = (over: Partial<WelcomeFacts> = {}): WelcomeFacts => ({
  welcomeRoomId: WELCOME,
  homeRoomId: HOME,
  firstRun: false,
  marked: false,
  reached: false,
  ...over,
});

describe('welcome only: who is still on the way to the welcome room', () => {
  it('a first run is seeking, and stays so on later starts by the saved mark', () => {
    expect(seekingWelcome(facts({ firstRun: true }))).toBe(true);
    // The identity is stored during the first run: the second start is no
    // first run, and only the mark says it never arrived.
    expect(seekingWelcome(facts({ marked: true }))).toBe(true);
    expect(seekingWelcome(facts({ firstRun: true, marked: true }))).toBe(true);
  });

  it('an install from before, with no mark, is a returning one', () => {
    expect(seekingWelcome(facts())).toBe(false);
  });

  it('ends with arrival, for the rest of the page too', () => {
    expect(seekingWelcome(facts({ firstRun: true, reached: true }))).toBe(false);
    expect(seekingWelcome(facts({ marked: true, reached: true }))).toBe(false);
  });

  it('never for the welcome room’s own host, or a build that ships no welcome link', () => {
    expect(seekingWelcome(facts({ firstRun: true, marked: true, homeRoomId: WELCOME }))).toBe(false);
    expect(seekingWelcome(facts({ firstRun: true, marked: true, welcomeRoomId: '' }))).toBe(false);
  });
});

describe('welcome only: what counts as arriving', () => {
  it('is the room’s own owner and name in the replica, both', () => {
    const doc = new Y.Doc();
    const roomInfo = doc.getMap('roomInfo');
    expect(welcomeStateHere(roomInfo)).toBe(false);
    roomInfo.set('name', 'SSF-WELCOME');
    expect(welcomeStateHere(roomInfo)).toBe(false);
    roomInfo.set('owner', 'player-1');
    expect(welcomeStateHere(roomInfo)).toBe(true);
  });

  it('arrives by a sync from a holder, and not from another install that is still waiting', () => {
    const host = new Y.Doc();
    host.getMap('roomInfo').set('owner', 'player-1');
    host.getMap('roomInfo').set('name', 'SSF-WELCOME');
    const waiting = new Y.Doc();
    waiting.getMap('players').set('newcomer-2', { name: 'B' });
    const mine = new Y.Doc();
    // Linked to the other newcomer: its replica merges, and brings no room.
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(waiting));
    expect(mine.getMap('players').size).toBe(1);
    expect(welcomeStateHere(mine.getMap('roomInfo'))).toBe(false);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(host));
    expect(welcomeStateHere(mine.getMap('roomInfo'))).toBe(true);
  });
});

describe('welcome only: the saved mark', () => {
  it('is saved, read and removed under one key', () => {
    const store = memoryStore();
    expect(welcomeMarked(store)).toBe(false);
    markWelcomePending(store);
    expect(store.map.get(WELCOME_PENDING_KEY)).toBe('1');
    expect(welcomeMarked(store)).toBe(true);
    clearWelcomePending(store);
    expect(store.map.has(WELCOME_PENDING_KEY)).toBe(false);
    expect(welcomeMarked(store)).toBe(false);
  });

  it('reads as absent, and never throws, where storage is closed', () => {
    for (const store of [throwingStore, null, undefined]) {
      expect(() => markWelcomePending(store)).not.toThrow();
      expect(() => clearWelcomePending(store)).not.toThrow();
      expect(welcomeMarked(store)).toBe(false);
    }
  });

  it('only its own value counts', () => {
    const store = memoryStore();
    store.setItem(WELCOME_PENDING_KEY, 'true');
    expect(welcomeMarked(store)).toBe(false);
  });
});

describe('welcome only: where a boot goes', () => {
  it('a seeking install docks at the welcome room: never home, never a resume', () => {
    expect(bootRoute(true, null, WELCOME, false)).toBe('dock');
    expect(bootRoute(true, null, WELCOME, true)).toBe('dock');
  });

  it('a seeking install whose override is the welcome room is docking again (Retry-node)', () => {
    expect(bootRoute(true, WELCOME, WELCOME, false)).toBe('dock');
    expect(bootRoute(true, WELCOME, WELCOME, true)).toBe('dock');
  });

  it('an explicit link to another room wins for that start, seeking or not', () => {
    expect(bootRoute(true, OTHER, WELCOME, true)).toBe('explicit');
    expect(bootRoute(false, OTHER, WELCOME, true)).toBe('explicit');
    // A returning install that pastes the welcome pass joins it like any pass.
    expect(bootRoute(false, WELCOME, WELCOME, false)).toBe('explicit');
  });

  it('a returning install resumes its last room, else boots its own module', () => {
    expect(bootRoute(false, null, WELCOME, true)).toBe('resume');
    expect(bootRoute(false, null, WELCOME, false)).toBe('home');
  });

  it('no route is home while seeking, whatever else is set', () => {
    for (const override of [null, WELCOME, OTHER]) {
      for (const last of [false, true]) {
        expect(bootRoute(true, override, WELCOME, last)).not.toBe('home');
        expect(bootRoute(true, override, WELCOME, last)).not.toBe('resume');
      }
    }
  });
});

describe('welcome only: the pace of the asks', () => {
  it('starts at the first wait, doubles, and holds at the cap', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(welcomeSeekDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
    expect(welcomeSeekDelayMs(0)).toBe(WELCOME_FIRST_WAIT_MS);
    expect(welcomeSeekDelayMs(1e9)).toBe(WELCOME_SEEK_CAP_MS);
  });

  it('a round that is no round waits the first wait', () => {
    for (const round of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(welcomeSeekDelayMs(round)).toBe(WELCOME_FIRST_WAIT_MS);
    }
    expect(welcomeSeekDelayMs(Number.POSITIVE_INFINITY)).toBe(WELCOME_FIRST_WAIT_MS);
    expect(welcomeSeekDelayMs(2.9)).toBe(120_000);
  });
});

describe('welcome only: what the player is told', () => {
  it('names the room, says the computer keeps trying, and never offers a module of their own as the way out', () => {
    const waiting = welcomeWaitingLine('SSF-WELCOME');
    expect(waiting).toContain('SSF-WELCOME has not answered yet');
    expect(waiting).toContain('Your computer keeps trying');
    for (const line of [waiting, welcomeStillWaitingLine('SSF-WELCOME'), welcomeRetryLine('SSF-WELCOME'), welcomeNodeLostLine('SSF-WELCOME')]) {
      expect(line).toContain('SSF-WELCOME');
      expect(line).not.toMatch(/your own module|booting|station node/i);
    }
    expect(welcomeRetryLine('SSF-WELCOME')).toContain('tries again by itself');
    // A node that went away is the player's own, and is said so: no claim that anything keeps trying meanwhile.
    expect(welcomeNodeLostLine('SSF-WELCOME')).toContain("Your computer's own node stopped answering");
    expect(welcomeNodeLostLine('SSF-WELCOME')).not.toMatch(/keeps trying/);
  });

  it('on arrival says how a room of one’s own is made: by asking', () => {
    expect(welcomeArrivedLine('SSF-WELCOME')).toBe(
      "🛰️ Welcome aboard SSF-WELCOME. Any door's keypad can PROVISION NEW MODULE when you want a room of your own.",
    );
  });
});

describe('welcome only: the seek of one welcome-room session (seekWelcome)', () => {
  /** A session whose waits the test ends by hand: `tick()` lets the wait under way time out. */
  function session() {
    const waits: number[] = [];
    const said: string[] = [];
    let asks = 0;
    let endWait: () => void = () => {};
    let loseLink: () => void = () => {};
    const state = { arrived: false, current: true };
    const deps: WelcomeSeekDeps = {
      name: 'SSF-WELCOME',
      wait: (ms) => {
        waits.push(ms);
        return new Promise<void>((resolve) => (endWait = resolve));
      },
      linkLost: new Promise<void>((resolve) => (loseLink = resolve)),
      ask: () => void asks++,
      arrived: () => state.arrived,
      current: () => state.current,
      say: (line) => void said.push(line),
    };
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    return {
      deps, waits, said, state,
      asks: () => asks,
      tick: async () => { endWait(); await flush(); },
      loseLink: async () => { loseLink(); await flush(); },
      flush,
    };
  }

  it('waits the first wait without asking, says the room has not answered, then asks at the pace for as long as it takes', async () => {
    const s = session();
    const end = seekWelcome(s.deps);
    await s.flush();
    expect(s.waits).toEqual([30_000]);
    expect(s.asks()).toBe(0); // the join was the first ask
    expect(s.said).toEqual([]);
    await s.tick();
    expect(s.said).toEqual([welcomeWaitingLine('SSF-WELCOME')]);
    expect(s.asks()).toBe(1);
    for (let i = 0; i < 6; i++) await s.tick();
    expect(s.waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000]);
    expect(s.asks()).toBe(7); // one ask before every wait but the first
    expect(s.said.slice(1)).toEqual(Array(6).fill(welcomeStillWaitingLine('SSF-WELCOME')));
    s.state.arrived = true;
    await s.tick();
    await expect(end).resolves.toBe('arrived');
    expect(s.said).toHaveLength(7); // nothing more is said by the seek: the arrival has its own line
  });

  it('ends at once on arrival, whenever in a wait it comes', async () => {
    const s = session();
    const end = seekWelcome(s.deps);
    await s.flush();
    s.state.arrived = true;
    await s.tick(); // the wait resolves on the state landing
    await expect(end).resolves.toBe('arrived');
    expect(s.asks()).toBe(0);
    expect(s.said).toEqual([]);
  });

  it('ends silently when the session is no longer the live one', async () => {
    const s = session();
    const end = seekWelcome(s.deps);
    await s.tick();
    s.state.current = false; // the player followed a link, or Retry-node docked afresh
    await s.tick();
    await expect(end).resolves.toBe('superseded');
    expect(s.asks()).toBe(1);
    expect(s.said).toEqual([welcomeWaitingLine('SSF-WELCOME')]);
  });

  it('stops asking the moment the link to the player\'s own node is lost, mid-wait', async () => {
    const s = session();
    const end = seekWelcome(s.deps);
    await s.tick();
    await s.tick();
    expect(s.asks()).toBe(2);
    await s.loseLink(); // no wait has to time out first
    await expect(end).resolves.toBe('link-lost');
    expect(s.asks()).toBe(2); // a closed link is not asked again
    expect(s.said).toEqual([welcomeWaitingLine('SSF-WELCOME'), welcomeStillWaitingLine('SSF-WELCOME')]);
  });

  it('an arrival or a newer session counts before a lost link', async () => {
    const a = session();
    const endA = seekWelcome(a.deps);
    await a.flush();
    a.state.arrived = true;
    await a.loseLink();
    await expect(endA).resolves.toBe('arrived');

    const b = session();
    const endB = seekWelcome(b.deps);
    await b.flush();
    b.state.current = false; // our own leave closed that link: nothing to dock afresh for
    await b.loseLink();
    await expect(endB).resolves.toBe('superseded');
  });
});

describe('welcome only: after the link to the player\'s own node is lost (recoverLostLink)', () => {
  /** One lost session: what was done, in order, and a swap to end by hand. */
  function lost(over: { current?: boolean; swapping?: boolean; leaveFails?: boolean } = {}) {
    const did: string[] = [];
    const state = { current: over.current ?? true };
    let endSwap: () => void = () => {};
    const swap = over.swapping ? new Promise<void>((resolve) => (endSwap = resolve)) : Promise.resolve();
    const done = recoverLostLink({
      swapEnded: () => swap,
      current: () => state.current,
      leave: async () => {
        did.push('leave');
        if (over.leaveFails) throw new Error('leave failed');
      },
      retry: () => void did.push('retry'),
    });
    return { did, state, endSwap: () => endSwap(), done };
  }

  it('leaves the dead session, then arms the retry', async () => {
    const s = lost();
    await s.done;
    expect(s.did).toEqual(['leave', 'retry']);
  });

  it('waits a room swap out, and leaves the dead session the swap ended in', async () => {
    const s = lost({ swapping: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(s.did).toEqual([]); // the swap owns the session: nothing is torn down under it
    s.endSwap(); // it finished, the session whose link closed still the live one
    await s.done;
    expect(s.did).toEqual(['leave', 'retry']);
  });

  it('leaves nothing when the swap put another session in its place, and still arms the retry', async () => {
    const s = lost({ swapping: true });
    s.state.current = false; // the swap failed on the closed link and restored or stranded by itself
    s.endSwap();
    await s.done;
    expect(s.did).toEqual(['retry']);
  });

  it('arms the retry even when the leave fails', async () => {
    const s = lost({ leaveFails: true });
    await expect(s.done).rejects.toThrow('leave failed');
    expect(s.did).toEqual(['leave', 'retry']);
  });
});

describe('welcome only: the pass an arrival keeps in MY ROOMS (welcomePassToKeep)', () => {
  interface Boot {
    roomId: string;
    routes: string[];
  }
  /** A pass here is `room|route,route`. */
  const codec: PassCodec<Boot> = {
    decode: (pass) => {
      const [roomId, routes] = pass.split('|');
      return roomId && routes !== undefined ? { roomId, routes: routes.split(',').filter(Boolean) } : null;
    },
    encode: (boot) => `${boot.roomId}|${boot.routes.join(',')}`,
    withRoutes: (held, extra) => ({ ...held, routes: [...new Set([...held.routes, ...extra.routes])] }),
  };
  const BUNDLED = `${WELCOME}|host`;

  it('is the bundled link when the player has no pass of their own to the room', () => {
    expect(welcomePassToKeep(null, BUNDLED, codec)).toBe(BUNDLED);
    expect(welcomePassToKeep(undefined, BUNDLED, codec)).toBe(BUNDLED);
    expect(welcomePassToKeep('', BUNDLED, codec)).toBe(BUNDLED);
  });

  it('keeps the player\'s own pass, its holder first, with the bundled routes beside it', () => {
    expect(welcomePassToKeep(`${WELCOME}|friend`, BUNDLED, codec)).toBe(`${WELCOME}|friend,host`);
  });

  it('leaves the bundled link as it is when that is the pass the player holds', () => {
    let encoded = 0;
    const counting: PassCodec<Boot> = { ...codec, encode: (b) => (encoded++, codec.encode(b)) };
    expect(welcomePassToKeep(BUNDLED, BUNDLED, counting)).toBe(BUNDLED);
    expect(encoded).toBe(0);
  });

  it('is the bundled link when the player\'s pass is unreadable or names another room', () => {
    expect(welcomePassToKeep('junk', BUNDLED, codec)).toBe(BUNDLED);
    expect(welcomePassToKeep(`${OTHER}|friend`, BUNDLED, codec)).toBe(BUNDLED);
  });

  it('leaves the player\'s pass as it is when it cannot be rewritten', () => {
    const failing: PassCodec<Boot> = {
      ...codec,
      encode: () => {
        throw new Error('not Latin-1');
      },
    };
    expect(welcomePassToKeep(`${WELCOME}|friend`, BUNDLED, failing)).toBe(`${WELCOME}|friend`);
  });

  // Review round 3: a still-seeking install with a pass saved before opens the
  // page with a fresh one. The docking uses the fresh pass's holder, and the
  // filing must not drop it for the saved pass alone.
  it('keeps both of the player\'s passes: the one the page was opened with leads, the saved one and the bundled ride beside it', () => {
    expect(welcomePassToKeep([`${WELCOME}|fresh`, `${WELCOME}|saved`], BUNDLED, codec)).toBe(`${WELCOME}|fresh,saved,host`);
    // One of the two alone is as before.
    expect(welcomePassToKeep([null, `${WELCOME}|saved`], BUNDLED, codec)).toBe(`${WELCOME}|saved,host`);
    expect(welcomePassToKeep([`${WELCOME}|fresh`, null], BUNDLED, codec)).toBe(`${WELCOME}|fresh,host`);
    expect(welcomePassToKeep([null, undefined, ''], BUNDLED, codec)).toBe(BUNDLED);
  });

  it('of two passes, one that is unreadable, names another room, or is the bundled link adds nothing and takes nothing', () => {
    expect(welcomePassToKeep(['junk', `${WELCOME}|saved`], BUNDLED, codec)).toBe(`${WELCOME}|saved,host`);
    expect(welcomePassToKeep([`${OTHER}|elsewhere`, `${WELCOME}|saved`], BUNDLED, codec)).toBe(`${WELCOME}|saved,host`);
    expect(welcomePassToKeep([`${WELCOME}|fresh`, `${OTHER}|elsewhere`], BUNDLED, codec)).toBe(`${WELCOME}|fresh,host`);
    expect(welcomePassToKeep([BUNDLED, `${WELCOME}|saved`], BUNDLED, codec)).toBe(`${WELCOME}|saved,host`);
    expect(welcomePassToKeep(['junk', `${OTHER}|elsewhere`], BUNDLED, codec)).toBe(BUNDLED);
  });

  it('of two passes that cannot be rewritten, the leading one stays as it is', () => {
    const failing: PassCodec<Boot> = {
      ...codec,
      encode: () => {
        throw new Error('not Latin-1');
      },
    };
    expect(welcomePassToKeep([`${WELCOME}|fresh`, `${WELCOME}|saved`], BUNDLED, failing)).toBe(`${WELCOME}|fresh`);
  });
});

describe('welcome only: a welcome-room session also asks the holders of the pass the player holds (welcomeRecordWithHeld)', () => {
  interface Boot {
    roomId: string;
    link: string;
    routes: string[];
  }
  const withRoutes = (held: Boot, extra: Boot): Boot => ({ ...held, routes: [...new Set([...held.routes, ...extra.routes])] });
  const record: Boot = { roomId: WELCOME, link: 'this computer', routes: ['host'] };

  it('adds the held pass\'s holders after the record\'s own, and leaves the record\'s link to the player\'s node as it is', () => {
    const held: Boot = { roomId: WELCOME, link: 'the minter', routes: ['friend', 'host'] };
    expect(welcomeRecordWithHeld(record, WELCOME, held, withRoutes)).toEqual({
      roomId: WELCOME,
      link: 'this computer',
      routes: ['host', 'friend'],
    });
    // The record handed in is not changed: the next handshake starts from it again.
    expect(record.routes).toEqual(['host']);
  });

  it('returns the very record when there is no readable pass to add', () => {
    expect(welcomeRecordWithHeld(record, WELCOME, null, withRoutes)).toBe(record);
    expect(welcomeRecordWithHeld(record, WELCOME, undefined, withRoutes)).toBe(record);
  });

  it('adds nothing from a pass to another room, and nothing to another room\'s record', () => {
    const elsewhere: Boot = { roomId: OTHER, link: 'the minter', routes: ['stranger'] };
    expect(welcomeRecordWithHeld(record, WELCOME, elsewhere, withRoutes)).toBe(record);
    const otherRecord: Boot = { roomId: OTHER, link: 'this computer', routes: ['owner'] };
    const held: Boot = { roomId: WELCOME, link: 'the minter', routes: ['friend'] };
    expect(welcomeRecordWithHeld(otherRecord, WELCOME, held, withRoutes)).toBe(otherRecord);
  });

  it('passes on no record, and does nothing in a build with no welcome room', () => {
    const held: Boot = { roomId: WELCOME, link: 'the minter', routes: ['friend'] };
    expect(welcomeRecordWithHeld(null, WELCOME, held, withRoutes)).toBeNull();
    const blank: Boot = { roomId: '', link: 'this computer', routes: [] };
    expect(welcomeRecordWithHeld(blank, '', { ...held, roomId: '' }, withRoutes)).toBe(blank);
  });
});

describe('welcome only: a boot that lost the session stands down (bootYields)', () => {
  it('goes on while the session count stands where the boot began and no room swap runs', () => {
    expect(bootYields(0, 0, false)).toBe(false);
    expect(bootYields(7, 7, false)).toBe(false);
  });

  it('stands down once any join or leave has moved the count: Retry-node, a pass the player followed, a second boot', () => {
    expect(bootYields(3, 4, false)).toBe(true);
    expect(bootYields(3, 9, false)).toBe(true);
  });

  it('stands down while a room swap is under way, whatever the count', () => {
    expect(bootYields(3, 3, true)).toBe(true);
    expect(bootYields(3, 4, true)).toBe(true);
  });
});

describe('welcome only: a pass to the welcome room added while standing in it (welcomePassAddedLine)', () => {
  it('while the room has not answered, says the pass is saved and its computers are asked now, and promises no entry', () => {
    const line = welcomePassAddedLine('SSF-WELCOME', true);
    expect(line).toContain('Pass saved');
    expect(line).toContain('SSF-WELCOME');
    expect(line).toContain('Your computer now asks the computers it names');
    expect(line).toContain('fills in by itself');
    expect(line).not.toMatch(/taken in|automatically|station/i);
  });

  it('once the room is here, says so and that the pass is saved', () => {
    const line = welcomePassAddedLine('SSF-WELCOME', false);
    expect(line).toBe('You are already aboard SSF-WELCOME. The pass is saved in MY ROOMS.');
  });
});
