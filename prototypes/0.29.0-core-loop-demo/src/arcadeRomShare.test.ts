/**
 * 🕹 arcadeRomShare — the owner's file, sent through the room doc to the
 * player who pressed play: pages are separate module instances on synced
 * Y.Docs (as two browsers are), the clock is each page's own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

type Share = typeof import('./arcadeRomShare');
type Doc = typeof import('./arcadeDoc');

interface Page {
  share: Share;
  doc: Doc;
  y: Y.Doc;
  now: number;
  tick: (ms?: number) => void;
}

/** A page of its own: fresh modules, its own doc, its own clock. */
async function page(name: string): Promise<Page> {
  vi.resetModules();
  const doc = await import('./arcadeDoc');
  const share = await import('./arcadeRomShare');
  const y = new Y.Doc();
  doc.bindArcadeDoc(y);
  doc.setArcadePageId(name);
  const p: Page = {
    share, doc, y, now: 1_000_000,
    tick: (ms = 500) => {
      p.now += ms;
      share.tickRomShare(p.now);
    },
  };
  share.setRomShareClock(() => p.now);
  return p;
}

/** Wire docs together like the mesh: every update reaches every other. */
function link(...pages: Page[]): void {
  for (const a of pages) {
    a.y.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'mesh') return;
      for (const b of pages) if (b !== a) Y.applyUpdate(b.y, update, 'mesh');
    });
  }
  for (const a of pages) for (const b of pages) if (a !== b) Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y), 'mesh');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rom(size: number, seed = 7): Uint8Array {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

/** Tick every page in turn, letting the hash checks finish between. */
async function run(pages: Page[], rounds: number, ms = 500): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    for (const p of pages) p.tick(ms);
    await flush();
  }
}

const romKeys = (p: Page) => [...p.y.getMap('arcade').keys()].filter((k) => k.startsWith('rom'));

afterEach(() => {
  vi.resetModules();
});

describe('sending the owner\'s file to the player who pressed play', () => {
  it('goes from the owner\'s page to the player\'s, checks out, and leaves nothing in the room', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const file = rom(300_000);
    const sha = await owner.share.sha256Hex(file);
    owner.share.holdRom(sha, file);
    expect(player.share.romProgress(sha)).toEqual({ state: 'none' });

    player.share.wantRom(sha, file.length);
    expect(player.share.romProgress(sha).state).toBe('asking');
    expect(romKeys(owner)).toEqual([`romask:${sha}:player`]);

    await run([owner, player], 1);
    const p = player.share.romProgress(sha);
    expect(p.state).toBe('have'); // five chunks of 64 KB: one tick's worth
    if (p.state === 'have') expect(p.bytes).toEqual(file);
    expect(romKeys(player)).not.toContain(`romask:${sha}:player`); // the ask is withdrawn

    // Nobody asking: the sender clears the chunks after LINGER_MS, and the
    // doc forgets the bytes (Yjs collects deleted content).
    await run([owner, player], 1 + owner.share.LINGER_MS / 500);
    expect(romKeys(owner)).toEqual([]);
    expect(Y.encodeStateAsUpdate(player.y).length).toBeLessThan(2_000);
  });

  it('paces a big file, CHUNKS_PER_TICK a tick, and the progress shows it', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const file = rom(owner.share.ROM_CHUNK_BYTES * 20 + 5);
    const sha = await owner.share.sha256Hex(file);
    owner.share.holdRom(sha, file);
    player.share.wantRom(sha, file.length);
    owner.tick();
    player.tick();
    expect(player.share.romProgress(sha)).toEqual({ state: 'receiving', got: owner.share.CHUNKS_PER_TICK, of: 21 });
    await run([owner, player], 3);
    expect(player.share.romProgress(sha).state).toBe('have');
  });

  it('a player who got it sends it on, when the owner has gone', async () => {
    const owner = await page('owner');
    const first = await page('first');
    const second = await page('second');
    link(owner, first, second);
    const file = rom(100_000);
    const sha = await owner.share.sha256Hex(file);
    owner.share.holdRom(sha, file);
    first.share.wantRom(sha, file.length);
    await run([owner, first, second], 2);
    expect(first.share.romProgress(sha).state).toBe('have');
    await run([owner, first, second], 1 + owner.share.LINGER_MS / 500);
    expect(romKeys(owner)).toEqual([]);

    // The owner leaves; the second player presses play.
    second.share.wantRom(sha, file.length);
    await run([first, second], 2);
    const p = second.share.romProgress(sha);
    expect(p.state).toBe('have');
    if (p.state === 'have') expect(p.bytes).toEqual(file);
  });

  it('a send whose page left goes stale, and another holder finishes it', async () => {
    const a = await page('a');
    const b = await page('b');
    const player = await page('player');
    link(a, b, player);
    const file = rom(a.share.ROM_CHUNK_BYTES * 30);
    const sha = await a.share.sha256Hex(file);
    a.share.holdRom(sha, file);
    player.share.wantRom(sha, file.length);
    a.tick(); // a claims the send and writes its first chunks, then leaves
    b.share.holdRom(sha, file);
    await run([b, player], 2);
    expect(player.share.romProgress(sha).state).toBe('receiving'); // b leaves a's send alone…
    await run([b, player], Math.ceil(b.share.SEND_LAPSE_MS / 500) + 4);
    expect(player.share.romProgress(sha).state).toBe('have'); // …until it stops moving
  });

  it('a copy that does not match the owner\'s hash is not used', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const file = rom(70_000);
    const sha = await owner.share.sha256Hex(file);
    // A peer sends other bytes under the owner's hash.
    owner.share.holdRom(sha, rom(70_000, 99));
    player.share.wantRom(sha, file.length);
    await run([owner, player], 2);
    const p = player.share.romProgress(sha);
    expect(p.state).toBe('asking');
    if (p.state === 'asking') expect(p.bad).toBe(true);
  });

  it('bad bytes a peer left in the room are cleared, and the next sender starts clean', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const file = rom(owner.share.ROM_CHUNK_BYTES + 5_000);
    const sha = await owner.share.sha256Hex(file);
    player.share.wantRom(sha, file.length);
    // A peer wrote other bytes under the owner's hash, under a fresh claim.
    const bad = rom(file.length, 99);
    const map = owner.y.getMap('arcade');
    map.set(`romsend:${sha}`, { size: file.length, chunks: 2, by: 'x', at: 1 });
    map.set(`romc:${sha}:0`, bad.slice(0, owner.share.ROM_CHUNK_BYTES));
    map.set(`romc:${sha}:1`, bad.slice(owner.share.ROM_CHUNK_BYTES));
    await run([player], 1);
    expect(player.share.romProgress(sha)).toMatchObject({ state: 'asking', bad: true });
    expect(romKeys(owner)).toEqual([`romask:${sha}:player`]); // the claim and its chunks are gone

    owner.share.holdRom(sha, file); // the owner comes back: nothing to wait out, nothing to skip
    await run([owner, player], 1);
    const p = player.share.romProgress(sha);
    expect(p.state).toBe('have');
    if (p.state === 'have') expect(p.bytes).toEqual(file);
  });

  it('reads nothing a peer shaped wrong, and asks for nothing too big', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const { ROM_SHARE_MAX_BYTES, ROM_CHUNK_BYTES } = player.share;
    const sha = 'a'.repeat(64);
    player.share.wantRom(sha, ROM_SHARE_MAX_BYTES + 1);
    player.share.wantRom('not-a-hash', 10);
    expect(player.share.romProgress(sha)).toEqual({ state: 'none' });
    expect(romKeys(player)).toEqual([]);
    player.share.holdRom(sha, new Uint8Array(ROM_SHARE_MAX_BYTES + 1));
    expect(player.share.heldRom(sha)).toBeNull();

    player.share.wantRom(sha, ROM_CHUNK_BYTES + 10);
    const map = owner.y.getMap('arcade');
    map.set(`romsend:${sha}`, { size: ROM_CHUNK_BYTES + 10, chunks: 7, by: 'x', at: 1 }); // wrong count
    map.set(`romc:${sha}:0`, new Uint8Array(ROM_CHUNK_BYTES));
    map.set(`romc:${sha}:1`, 'ten bytes!');
    player.tick();
    expect(player.share.romProgress(sha).state).toBe('asking');
    map.set(`romsend:${sha}`, { size: ROM_CHUNK_BYTES + 10, chunks: 2, by: 'x', at: 1 });
    player.tick();
    expect(player.share.romProgress(sha)).toEqual({ state: 'receiving', got: 1, of: 2 }); // the string is not a chunk
  });

  it('withdrawing the ask (the player stood up) clears it from the room', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const sha = 'b'.repeat(64);
    player.share.wantRom(sha, 1000);
    expect(romKeys(owner)).toEqual([`romask:${sha}:player`]);
    player.share.dropWant(sha);
    expect(romKeys(owner)).toEqual([]);
    expect(player.share.romProgress(sha)).toEqual({ state: 'none' });
  });

  it('an ask nobody renews is cleared by any page', async () => {
    const owner = await page('owner');
    const player = await page('player');
    link(owner, player);
    const sha = 'c'.repeat(64);
    player.share.wantRom(sha, 1000); // and then the player's page is gone
    await run([owner], Math.ceil(owner.share.ASK_LAPSE_MS / 500) + 1);
    expect(romKeys(owner)).toEqual([]);
  });
});
