#!/usr/bin/env node
/**
 * 🔗 The page's side of the two-computer link drill (#231 P4), with no hands
 * in the game. One run is one player's browser: it opens the game page
 * against the node on this computer and stays in the room, printing what
 * the page sees, while the node's own log tells the chain's part.
 *
 *   host:  opens its home room, makes it PRIVATE (every door "owner", the
 *          keypad's own setting), waits for the node's contact card and
 *          writes an invite that carries it.
 *   guest: opens that invite and stays in the host's room.
 *
 * A room is private space only when no door lets anyone walk in, and only a
 * private room's invite carries contact cards (roomCap.ts `cardsForPass`):
 * without the door step nothing of the Phone Book's card path happens.
 *
 * Needs the node running on this computer and the dev server up
 * (`npm run dev -- --open false`). Playwright is not a dependency of this
 * project: `npm i --no-save playwright-core` and pass `--channel msedge` (or
 * `chrome`) to drive a browser the computer already has, or
 * `npm i --no-save playwright` for its own Chromium.
 *
 *   node scripts/drill-link.mjs --role host  --invite-out invite.txt
 *   node scripts/drill-link.mjs --role guest --invite @invite.txt
 *        [--page http://localhost:5173] [--node-port 8080|8081]
 *        [--profile ./drill-profile] [--name Ada] [--minutes 60]
 *        [--status-every 30] [--channel msedge] [--chromium /path/to/chrome]
 *
 * --node-port: the page looks for its node on 127.0.0.1:8080, then 8081.
 * With two nodes on one computer, name the one this page belongs to and
 * the other port is refused for this browser alone.
 * --profile: the browser's own folder, kept between runs, so the player
 * and its home room are the same after a restart, as a player's are.
 *
 * Exits 0 when its time is up (or on Ctrl-C) after the role's steps were
 * done, 1 when a step failed. The invite is a secret of the drill's room:
 * it is written to the file named, and only its size is printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const role = arg('role', '');
const base = arg('page', 'http://localhost:5173').replace(/\/+$/, '');
const nodePort = arg('node-port', '');
const profile = resolve(arg('profile', `./drill-profile-${role || 'x'}`));
const name = arg('name', role === 'host' ? 'DrillHost' : 'DrillGuest');
const minutes = Number(arg('minutes', '60'));
const statusEvery = Math.max(5, Number(arg('status-every', '30')) || 30);
const channel = arg('channel', undefined);
const executablePath = arg('chromium', process.env.CHROMIUM_PATH);
const inviteArg = arg('invite', '');
const inviteOut = arg('invite-out', 'invite.txt');

if (role !== 'host' && role !== 'guest') {
  console.error('[drill] --role host or --role guest');
  process.exit(2);
}
if (nodePort && nodePort !== '8080' && nodePort !== '8081') {
  console.error('[drill] --node-port is 8080 or 8081, the two the page looks at');
  process.exit(2);
}
if (role === 'guest' && !inviteArg) {
  console.error('[drill] a guest needs --invite <link> or --invite @file');
  process.exit(2);
}

let chromium;
for (const pkg of ['playwright', 'playwright-core']) {
  try {
    ({ chromium } = await import(pkg));
    break;
  } catch { /* the other one */ }
}
if (!chromium) {
  console.error('[drill] playwright is not installed: npm i --no-save playwright-core (with --channel msedge) or npm i --no-save playwright');
  process.exit(2);
}

const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}Z +${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

/** The seed of an invite: the link's `seed` parameter, or a bare seed. */
function seedOf(raw) {
  const text = raw.trim();
  try {
    const seed = new URL(text).searchParams.get('seed');
    if (seed) return seed;
  } catch { /* not a link: a bare seed */ }
  return text;
}
/** What an invite says, for the log: never the room key. */
function inviteFacts(seed) {
  try {
    const boot = JSON.parse(Buffer.from(seed, 'base64').toString('utf8'));
    const hints = Array.isArray(boot.memberHints) ? boot.memberHints : [];
    return {
      roomId: boot.roomId,
      memberHints: hints.length,
      cards: hints.filter((h) => h && h.nodeCard).length,
      directAddrs: hints.reduce((n, h) => n + (Array.isArray(h?.irohDirectAddrs) ? h.irohDirectAddrs.length : 0), 0),
      relays: hints.reduce((n, h) => n + (Array.isArray(h?.irohRelayUrls) ? h.irohRelayUrls.length : 0), 0),
    };
  } catch {
    return null;
  }
}

mkdirSync(profile, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel,
  executablePath,
  headless: true,
  viewport: { width: 640, height: 420 },
  args: [
    '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-compositing',
  ],
});

// This page's node, when two run on one computer: the page asks 8080 first
// and 8081 second, so refusing the other one for this browser pins it.
if (nodePort) {
  const other = nodePort === '8080' ? '8081' : '8080';
  await ctx.route(`http://127.0.0.1:${other}/**`, (route) => route.abort());
}

/** Before the page's own scripts: a player of its own on a first run (so the
 *  page opens its home room, not the start screen's welcome room), the
 *  room's drawing slowed and skipped (nobody watches it, and software WebGL
 *  is costly), and the page's own module instances by name. */
await ctx.addInitScript({
  content: `(() => {
  if (window.top !== window) return;
  try {
    if (!localStorage.getItem('ssf-identity-seed')) {
      const b = crypto.getRandomValues(new Uint8Array(32));
      localStorage.setItem('ssf-identity-seed', btoa(String.fromCharCode(...b)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''));
      localStorage.setItem('ssf-player-name', ${JSON.stringify(name)});
    }
  } catch { /* storage refused */ }
  performance.setResourceTimingBufferSize(10000);
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 200);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'blitFramebuffer']) {
      const f = C.prototype[m];
      if (typeof f === 'function') C.prototype[m] = function () { if (window.__drawRoom) return f.apply(this, arguments); };
    }
  }
  window.__mod = async (n) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => new URL(u).pathname === '/src/' + n + '.ts').pop();
    return import(hit ?? '/src/' + n + '.ts');
  };
})();`,
});

const page = ctx.pages()[0] ?? await ctx.newPage();
const seenErrors = new Set();
page.on('pageerror', (e) => {
  const m = e.message.slice(0, 200);
  if (!seenErrors.has(m)) log(`[page error] ${m}`);
  seenErrors.add(m);
});

let failed = false;
const fail = async (why) => {
  failed = true;
  log(`FAILED: ${why}`);
};

/** What the page sees now: its room, its node, who is in the room. */
const status = () => page.evaluate(() => {
  const doc = window.__ssfDoc;
  const info = doc ? doc.getMap('roomInfo') : null;
  const np = window.networkProvider;
  let players = null;
  try { players = doc ? doc.getMap('players').size : null; } catch { /* not there */ }
  let card = false;
  try { card = !!localStorage.getItem('ssf-node-card'); } catch { /* storage refused */ }
  return {
    room: window.__ssfRoomId ?? null,
    // The room's owner record is there: for a guest, the host's state arrived.
    ownerKnown: info ? !!info.get('owner') : false,
    mode: np && typeof np.mode === 'function' ? np.mode() : null,
    players,
    nodeCard: card,
  };
}).catch((e) => ({ error: String(e).slice(0, 120) }));

const inRoom = (room) => !!(window.__ssfDoc && window.__ssfDoc.getMap('roomInfo').get('owner')
  && window.networkProvider && window.networkProvider.mode() !== 'offline' && (!room || window.__ssfRoomId === room));

let room = null;
if (role === 'host') {
  await page.goto(`${base}/`);
  log(`host: page open at ${base}, waiting for its home room and its node`);
  try {
    await page.waitForFunction(inRoom, null, { timeout: 120_000 });
  } catch {
    await fail('the page never got into a room with its node: is the node running on this computer, and is this the right --node-port?');
  }
  if (!failed) {
    room = await page.evaluate(() => window.__ssfRoomId);
    log(`host: in room ${room}`);
    // Private space: no door lets anyone walk in. The keypad's own writer,
    // for the four berths and every door the room has.
    const doors = await page.evaluate(async () => {
      const policy = await window.__mod('doorPolicy');
      const layout = await window.__mod('doorLayoutDoc');
      const ids = new Set(['north', 'south', 'east', 'west', ...layout.readAllDoorLayout().keys()]);
      for (const id of ids) policy.writeDoorPolicy(id, { ...policy.readDoorPolicy(id), passage: 'owner' });
      return [...ids].map((id) => `${id}:${policy.readDoorPolicy(id).passage}`);
    });
    log(`host: doors set to owner-only: ${doors.join(' ')}`);
    try {
      await page.waitForFunction(() => !!localStorage.getItem('ssf-node-card'), null, { timeout: 90_000 });
      log("host: the node's contact card reached the page");
    } catch {
      await fail("the node's contact card never reached the page (the node hands it out only to a room it was told is private, with SSF_CHIA_SHARE_CARD not 0)");
    }
  }
  if (!failed) {
    let link = null;
    let facts = null;
    for (let i = 0; i < 60 && !(facts && facts.cards > 0); i++) {
      const r = await page.evaluate(async () => (await window.__mod('main')).generateBootstrapLink());
      link = r.link ?? null;
      facts = link ? inviteFacts(seedOf(link)) : null;
      if (!(facts && facts.cards > 0)) {
        if (i % 5 === 0) log(`host: no invite with a card yet (${r.error ?? JSON.stringify(facts)})`);
        await page.waitForTimeout(1000);
      }
    }
    if (facts && facts.cards > 0) {
      writeFileSync(inviteOut, link, { encoding: 'utf8', mode: 0o600 });
      log(`host: INVITE WRITTEN to ${resolve(inviteOut)} (${link.length} characters): ${JSON.stringify(facts)}`);
    } else {
      await fail('no invite carrying a contact card could be made');
    }
  }
} else {
  const raw = inviteArg.startsWith('@') ? readFileSync(inviteArg.slice(1), 'utf8') : inviteArg;
  const seed = seedOf(raw);
  const facts = inviteFacts(seed);
  if (!facts || typeof facts.roomId !== 'string') {
    await fail('the invite could not be read');
  } else {
    room = facts.roomId;
    log(`guest: invite read: ${JSON.stringify(facts)}`);
    await page.goto(`${base}/?seed=${encodeURIComponent(seed)}`);
    log(`guest: page open with the invite, waiting to be in room ${room} with the host's state`);
    try {
      await page.waitForFunction(inRoom, room, { timeout: 180_000 });
      log(`guest: IN THE ROOM ${room}: the host's state arrived`);
    } catch {
      // Not a failure of the drill: with no live route this is where the
      // Phone Book's part begins. The page stays and keeps trying.
      log(`guest: not in the room after 180 s (no live route to the host yet); staying, the node keeps dialling`);
    }
  }
}

// Stay, as a player's browser does, and say now and then what the page sees.
let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
const until = t0 + minutes * 60_000;
let last = '';
while (!stop && !failed && Date.now() < until) {
  const s = JSON.stringify(await status());
  if (s !== last) log(`status changed: ${s}`);
  else log(`status: ${s}`);
  last = s;
  for (let waited = 0; waited < statusEvery && !stop; waited++) await new Promise((r) => setTimeout(r, 1000));
}
log(failed ? 'ending after a failed step' : stop ? 'stopped' : `time is up (${minutes} min)`);
await ctx.close().catch(() => {});
process.exit(failed ? 1 : 0);
