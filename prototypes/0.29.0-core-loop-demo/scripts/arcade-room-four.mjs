#!/usr/bin/env node
/**
 * 🕹🕹🕹🕹 Four players at the double-wide cabinet, each in a browser of its
 * own, in one room (#242). Player one's page opens its home room, places
 * the cabinet and puts a game on it; the others come in through its invite
 * link. Every player enters the room view, walks up to the cabinet, presses
 * the panel's INSERT COIN · PLAY AS and plays, pressing buttons at random.
 * After a while one player stands up and sits down again. Every 15 s it
 * prints each page's game in step and every state hash two pages computed
 * at the same frame of the same game, compared.
 *
 * Needs the dev server up (`npm run dev`), the node running on this machine
 * (the page's WebTransport endpoint), the emulator files in
 * public/emulatorjs/data/ (npm run fetch:emulatorjs) and a ROM the page can
 * fetch from its own origin. Playwright is not a dependency of this
 * project: `npm i --no-save playwright` first.
 *
 *   node scripts/arcade-room-four.mjs [--url http://localhost:5173] [--minutes 3]
 *        [--players 4] [--rom /emulatorjs/roms/lj65.nes] [--core nes]
 *        [--chromium /path/to/chrome] [--world-fps 10] [--draw-room 0]
 *
 * One machine draws every room in software (SwiftShader), which four rooms
 * saturate, so in each page's top frame the room's world loop runs at
 * --world-fps and its WebGL draws are skipped unless --draw-room 1. The
 * emulator frames are documents of their own, untouched. Compositing runs
 * on the CPU (--disable-gpu-compositing), a fifth of what SwiftShader costs.
 *
 * Exits non-zero when any compared hash differed, nothing was compared, a
 * walk-up to the cabinet failed, or a player never got to play.
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const base = arg('url', 'http://localhost:5173').replace(/\/+$/, '');
const minutes = Number(arg('minutes', '3'));
const howMany = Math.max(2, Math.min(4, Math.trunc(Number(arg('players', '4'))) || 4));
const romPath = arg('rom', '/emulatorjs/roms/lj65.nes');
const core = arg('core', 'nes');
const executablePath = arg('chromium', process.env.CHROMIUM_PATH);
const worldFps = Math.max(1, Number(arg('world-fps', '10')) || 10);
const drawRoom = arg('draw-room', '0') === '1';
const CAB = 'arcade-wide-room-four';
const NAMES = ['Ada', 'Bo', 'Cy', 'Di'];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('[room-four] playwright is not installed: npm i --no-save playwright');
  process.exit(2);
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const failures = [];

const browser = await chromium.launch({
  executablePath,
  args: [
    '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-compositing',
  ],
});

/** What the page's top frame runs before its own scripts: an identity of
 *  its own, the room's world loop slowed and its draws skipped (see the
 *  top), the page's own module instances by name, and a record of what
 *  the emulator frame and the room doc say. */
const initScript = (name) => `(() => {
  if (window.top !== window) return;
  try {
    if (!localStorage.getItem('ssf-identity-seed')) {
      const b = crypto.getRandomValues(new Uint8Array(32));
      localStorage.setItem('ssf-identity-seed', btoa(String.fromCharCode(...b)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''));
      localStorage.setItem('ssf-player-name', ${JSON.stringify(name)});
    }
  } catch { /* storage refused */ }
  performance.setResourceTimingBufferSize(10000);
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), ${Math.round(1000 / worldFps)});
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!${drawRoom}) {
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue;
      for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'blitFramebuffer']) {
        const f = C.prototype[m];
        if (typeof f === 'function') C.prototype[m] = function () { if (window.__drawRoom) return f.apply(this, arguments); };
      }
    }
  }
  // The page's own instance of a module: Vite may have loaded it as
  // name.ts?t=…, and importing it by another URL runs a second copy.
  window.__mod = async (n) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => new URL(u).pathname === '/src/' + n + '.ts').pop();
    return import(hit ?? '/src/' + n + '.ts');
  };
  const ls = { hashes: [], status: null, doc: [] };
  window.__ls = ls;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'arcade-replay-hash' && typeof d.nonce === 'string') {
      ls.hashes.push([d.nonce, d.frame, d.hash]);
      if (ls.hashes.length > 4000) ls.hashes.splice(0, 1000);
    } else if (d.type === 'arcade-replay-status') {
      ls.status = d;
    }
  });
  // Each transaction that touched the room's arcade map, as this page made
  // or heard it ([client, clock, at, local]): the lane's one-way time
  // between pages on one machine, one clock.
  const hooked = new WeakSet();
  setInterval(() => {
    const doc = window.__ssfDoc;
    if (!doc || hooked.has(doc)) return;
    hooked.add(doc);
    const arcade = doc.getMap('arcade');
    doc.on('afterTransaction', (tr) => {
      if (!tr.changed.has(arcade)) return;
      const at = Date.now();
      if (tr.local) {
        const k = tr.afterState.get(doc.clientID);
        if (k !== undefined) ls.doc.push([doc.clientID, k, at, 1]);
      } else {
        for (const [c, k] of tr.afterState) if (c !== doc.clientID && (tr.beforeState.get(c) ?? 0) < k) ls.doc.push([c, k, at, 0]);
      }
      if (ls.doc.length > 40000) ls.doc.splice(0, 10000);
    });
  }, 1000);
})();`;

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 420 } });
  await ctx.addInitScript({ content: initScript(name) });
  const page = await ctx.newPage();
  // Each error once a page (EmulatorJS's version check to its CDN, which
  // the page's CSP refuses, comes back as "Failed to fetch" at every start).
  const seen = new Set();
  page.on('pageerror', (e) => {
    const m = e.message.slice(0, 200);
    if (!seen.has(m)) log(`[${name} page error] ${m}`);
    seen.add(m);
  });
  return { name, page };
}

const ready = (room) => !!(window.__ssfDoc && window.__ssfDoc.getMap('roomInfo').get('owner') && window.world
  && window.world.furnitureGroups.size > 0 && (!room || window.__ssfRoomId === room));

// ── Into one room ──

const p1 = await player(NAMES[0]);
await p1.page.goto(`${base}/`);
await p1.page.waitForFunction(ready, null, { timeout: 90_000 });
let link;
for (let i = 0; i < 60 && !link; i++) {
  const r = await p1.page.evaluate(async () => (await window.__mod('main')).generateBootstrapLink());
  link = r.link;
  if (!link && i % 5 === 0) log('no invite link yet:', r.error);
  if (!link) await p1.page.waitForTimeout(1000);
}
if (!link) {
  log('no invite link: is the node running?');
  await browser.close();
  process.exit(1);
}
const room = await p1.page.evaluate(() => window.__ssfRoomId);
const players = [p1];
for (const name of NAMES.slice(1, howMany)) {
  const p = await player(name);
  await p.page.goto(link);
  players.push(p);
}
for (const p of players) await p.page.waitForFunction(ready, room, { timeout: 120_000 });
log(`${howMany} pages in room ${room}`);

// The owner places the cabinet and puts the game on it.
await p1.page.evaluate((id) => window.__ssfDoc.getMap('furniture').set(id, { kind: 'arcade-cabinet-wide', x: -2.5, z: -3.5, rot: 0, movable: true }), CAB);
for (const p of players) await p.page.waitForFunction((id) => window.world.furnitureGroups.has(id), CAB, { timeout: 30_000 });
const put = await p1.page.evaluate(async ({ id, path, core }) => {
  const url = new URL(path, location.origin).href;
  const size = (await (await fetch(url)).arrayBuffer()).byteLength;
  return (await window.__mod('arcadeDoc')).putOnCabinet(id, { name: path.split('/').pop(), core, url, size });
}, { id: CAB, path: romPath, core });
log('cabinet placed; game on it:', JSON.stringify(put));

// In as a player comes in: past the start screen, then the ENTER ROOM
// bubble over the dome (devices focus only from the room view, zoom 2),
// and out of the clone vat. The room's first spawn plays on a frame at the
// room view: a clone the vat let go of on its own while the page stayed
// outside is beamed back in then, which would cancel a walk-up begun
// before it. So the wait is for that spawn too, not only for no vat.
async function enter(p) {
  const fresh = p.page.locator('button', { hasText: 'NEW PLAYER' });
  if (await fresh.isVisible().catch(() => false)) await fresh.click();
  await p.page.locator('#exterior-enter-bubble').click({ timeout: 60_000 });
  await p.page.waitForFunction(() => window.multiScaleZoom?.getLevel?.() === 2, null, { timeout: 60_000 });
  await p.page.waitForFunction(() => !window.world.pendingVatSpawn && !window.world.player.isVatSpawning(), null, { timeout: 90_000 });
}
await Promise.all(players.map(enter));
log('every player is in the room view');

// ── Seats ──

const sitAt = new Map();
const joined = [];
/** Walk up to the cabinet (what a click on it does) and press the panel's
 *  big coin, as a player would. */
async function sit(p) {
  await p.page.evaluate(() => { window.__ls.status = null; });
  try {
    await p.page.evaluate((id) => window.world.requestDeviceFocus(id), CAB);
    const coin = p.page.locator('[data-arcade-coin]').filter({ hasText: 'PLAY AS' }).first();
    await coin.waitFor({ state: 'visible', timeout: 45_000 });
    const text = (await coin.textContent())?.replace(/\s+/g, ' ').trim();
    sitAt.set(p.name, Date.now());
    await coin.click({ timeout: 10_000 });
    await p.page.waitForSelector('#arcade-stage', { timeout: 15_000 });
    log(`${p.name} walked up and pressed "${text}"`);
    return true;
  } catch (e) {
    failures.push(`${p.name}: the walk-up failed`);
    log(`${p.name}: the walk-up failed (${String(e.message).split('\n')[0].slice(0, 160)})`);
    return false;
  }
}
/** Until the page's stage says it plays: alone, or in step with others. */
async function untilPlaying(p, capMs = 150_000) {
  const from = sitAt.get(p.name) ?? Date.now();
  while (Date.now() - from < capMs) {
    const text = await p.page.evaluate(() => document.querySelector('#arcade-stage .arcade-stage-status')?.textContent ?? '').catch(() => '');
    if (/IN STEP WITH|PLAYING ALONE/.test(text)) {
      const row = { name: p.name, playingS: +((Date.now() - from) / 1000).toFixed(1), text };
      joined.push(row);
      log(`${p.name} playing:`, JSON.stringify(row));
      return;
    }
    await p.page.waitForTimeout(250);
  }
  failures.push(`${p.name} never got to play`);
  log(`${p.name} NOT playing after ${capMs / 1000} s`);
}
async function standUp(p) {
  await p.page.locator('#arcade-stage [data-arcade-standup]').click({ timeout: 10_000 });
  log(`${p.name} pressed the stage's STAND UP`);
}

let pressing = true;
const keys = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'x', 'z'];
async function bot(p, seed) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  let lastStart = 0;
  while (pressing) {
    const open = await p.page.evaluate(() => !!document.querySelector('#arcade-stage iframe')).catch(() => false);
    if (!open) {
      await p.page.waitForTimeout(500);
      continue;
    }
    try {
      if (Date.now() - lastStart > 20_000) {
        // START now and then, so the game gets past its title.
        await p.page.locator('#arcade-stage .arcade-crt').click({ timeout: 2_000 });
        for (const _ of [0, 1]) {
          await p.page.keyboard.down('Enter');
          await p.page.waitForTimeout(90);
          await p.page.keyboard.up('Enter');
          await p.page.waitForTimeout(700);
        }
        lastStart = Date.now();
      }
      const k = keys[Math.floor(rnd() * keys.length)];
      await p.page.keyboard.down(k);
      await p.page.waitForTimeout(40 + rnd() * 220);
      await p.page.keyboard.up(k);
      await p.page.waitForTimeout(60 + rnd() * 400);
    } catch {
      await p.page.waitForTimeout(500);
    }
  }
}

// ── Reports ──

const quant = (xs, q) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : NaN);
let laneFrom = 0;
function laneLatency(docs, from) {
  const sent = new Map();
  for (const d of docs) for (const [c, k, at, local] of d) if (local) sent.set(`${c}:${k}`, at);
  const ms = [];
  for (const d of docs) for (const [c, k, at, local] of d) {
    if (local || at < from) continue;
    const s = sent.get(`${c}:${k}`);
    if (s !== undefined) ms.push(at - s);
  }
  ms.sort((a, b) => a - b);
  return ms.length ? `room doc one way: p50 ${quant(ms, 0.5)} ms · p90 ${quant(ms, 0.9)} · max ${ms[ms.length - 1]} (${ms.length} updates)` : 'room doc: -';
}
const last = new Map();
const epochs = new Set();
// Every frame of every game two pages hashed, and those whose hashes
// differed, kept from report to report: a page keeps only its latest
// 4,000 hashes, so a long run's early ones age out of its window.
const compared = new Set();
const mismatched = new Set();
async function report(label) {
  const now = Date.now();
  const rows = await Promise.all(players.map((p) => p.page.evaluate(() => ({
    text: document.querySelector('#arcade-stage .arcade-stage-status')?.textContent ?? '(no stage)',
    st: window.__ls.status,
    hashes: window.__ls.hashes.slice(),
    doc: window.__ls.doc.slice(),
  })).catch(() => ({ text: '(page gone)', st: null, hashes: [], doc: [] }))));
  const at = new Map();
  rows.forEach((r, i) => {
    for (const [nonce, frame, hash] of r.hashes) {
      epochs.add(nonce);
      const k = `${nonce}@${frame}`;
      const e = at.get(k) ?? { pages: new Set(), hashes: new Set() };
      e.pages.add(i);
      e.hashes.add(hash);
      at.set(k, e);
    }
  });
  for (const [k, e] of at) {
    if (e.pages.size < 2) continue;
    compared.add(k);
    if (e.hashes.size > 1) mismatched.add(k);
  }
  log(`── ${label} · hashes compared ${compared.size} · mismatched ${mismatched.size} · games in step so far ${epochs.size}`);
  log(`   ${laneLatency(rows.map((r) => r.doc), laneFrom)}`);
  laneFrom = now;
  rows.forEach((r, i) => {
    const p = players[i];
    const st = r.st ?? {};
    const prev = last.get(p.name);
    const fps = prev && st.frame !== undefined && st.nonce === prev.nonce ? ((st.frame - prev.frame) / ((now - prev.at) / 1000)).toFixed(1) : '-';
    if (st.frame !== undefined) last.set(p.name, { frame: st.frame, nonce: st.nonce, at: now });
    log(`   ${p.name.padEnd(3)} ${String(st.phase ?? '-').padEnd(8)} game ${String(st.nonce ?? '-').padEnd(9)} frame ${String(st.frame ?? '-').padStart(6)} · ${fps} fps · "${r.text}"`);
  });
}

// ── The run ──

const bots = players.map((p, i) => bot(p, 7 + i * 13));
const timer = setInterval(() => { void report('every 15 s').catch((e) => log('report failed:', e.message)); }, 15_000);
for (const p of players) {
  if (await sit(p)) await untilPlaying(p);
  await p1.page.waitForTimeout(5_000);
}
await report(`all ${howMany} seated`);
await p1.page.waitForTimeout(minutes * 60_000);
await report(`${howMany} playing`);
const leaver = players[howMany - 2];
await standUp(leaver).catch((e) => { failures.push(`${leaver.name} could not stand up`); log(e.message); });
await p1.page.waitForTimeout(20_000);
await report(`${leaver.name} stood up`);
if (await sit(leaver)) await untilPlaying(leaver);
await p1.page.waitForTimeout(30_000);
clearInterval(timer);
await report('end');
log('sitting down to playing:', JSON.stringify(joined));
pressing = false;
await Promise.allSettled(bots);
await browser.close();
if (compared.size === 0) failures.push('no hashes compared');
if (mismatched.size > 0) failures.push(`${mismatched.size} hashes differed`);
log(failures.length ? `failed: ${failures.join('; ')}` : 'passed');
process.exit(failures.length ? 1 : 0);
