#!/usr/bin/env node
/**
 * 🕹👀 Runs the input-replay spike (#193) in a headless Chromium and prints
 * what it measured: replay-spike.html with player one's frame and a
 * spectator replaying its inputs (src/arcadeReplaySpike.ts).
 *
 * Needs the dev server up (`npm run dev`), the emulator files in
 * public/emulatorjs/data/ (npm run fetch:emulatorjs) and a ROM the page can
 * fetch from its own origin. Playwright is not a dependency of this
 * project: `npm i --no-save playwright` first.
 *
 *   node scripts/arcade-replay-spike.mjs [--url http://localhost:5173] [--minutes 10]
 *        [--query "rom=/emulatorjs/roms/lj65.nes&latency=40&jitter=30"] [--chromium /path/to/chrome]
 *        [--screenshot out.png] [--page lockstep-spike.html]
 *
 * --page lockstep-spike.html runs the four-seat lockstep spike instead
 * (src/arcadeLockstepSpike.ts; its query takes seats, delay, batchFrames).
 *
 * Exits non-zero when any compared hash differed or nothing was compared
 * (the negative control, `--query drop=N`, is expected to).
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const base = arg('url', 'http://localhost:5173').replace(/\/+$/, '');
const minutes = Number(arg('minutes', '10'));
const query = arg('query', '');
const executablePath = arg('chromium', process.env.CHROMIUM_PATH);
const pageName = arg('page', 'replay-spike.html');
const lockstep = pageName.startsWith('lockstep');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('[replay-spike] playwright is not installed: npm i --no-save playwright');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
await page.goto(`${base}/${pageName}${query ? `?${query}` : ''}`);
const read = () => page.evaluate(() => (window.__replaySpike ?? window.__lockstepSpike)?.stats());
const started = Date.now();
const until = started + minutes * 60_000;
let last;
while (Date.now() < until) {
  await page.waitForTimeout(30_000);
  last = await read();
  const d = last?.drift;
  if (lockstep) {
    const seats = (last?.perSeat ?? []).map((p, i) => `${i + 1}:${p.status?.phase ?? '-'}@${p.status?.frame ?? '-'} held ${p.status?.waits ?? 0}`).join(' ');
    console.log(`[${((Date.now() - started) / 60_000).toFixed(1)} min] compared ${d?.compared} matched ${d?.matched} mismatched ${d?.mismatched} · ${seats}` +
      (last?.errors?.length ? ` · errors ${last.errors.join('; ')}` : ''));
    continue;
  }
  console.log(
    `[${((Date.now() - started) / 60_000).toFixed(1)} min] source frame ${last?.sourceFrame} · follower ${last?.follower?.phase} @ ${last?.follower?.frame}` +
      ` · compared ${d?.compared} matched ${d?.matched} mismatched ${d?.mismatched}` +
      ` · ${last?.inputs} inputs, ${last?.wireBytes} B · stalls ${last?.stalls}` +
      (last?.errors?.length ? ` · errors ${last.errors.join('; ')}` : ''),
  );
}
last = await read();
const shot = arg('screenshot', '');
if (shot) await page.screenshot({ path: shot });
await browser.close();
const lag = last?.lagFrames ?? [];
const sorted = [...lag].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const seconds = (Date.now() - started) / 1000;
if (lockstep) {
  // Seconds of lockstep, for the per-second rates: from the moment seat 0
  // began it (the page's own clock), and frames counted from that frame.
  const lockSeconds = Math.max(1, last?.lockSeconds ?? seconds);
  const lockFrame = last?.lockFrame ?? 0;
  console.log(JSON.stringify({
    minutes,
    query,
    seats: last?.seats,
    delay: last?.delay,
    drift: last?.drift,
    loads: last?.loads,
    snapshotBytes: last?.snapshotBytes,
    perSeat: (last?.perSeat ?? []).map((p) => ({
      phase: p.status?.phase,
      frame: p.status?.frame,
      stalls: p.status?.stalls,
      framesHeld: p.status?.waits,
      iterations: p.status?.iters,
      // The share of main-loop iterations spent holding for another seat.
      heldShare: p.status?.iters ? Number(((p.status.waits ?? 0) / p.status.iters).toFixed(3)) : null,
      // Game frames run per second of lockstep: 60 is full speed on NES.
      framesPerSecond: Number((((p.status?.frame ?? lockFrame) - lockFrame) / lockSeconds).toFixed(1)),
      iterationsPerSecond: Number(((p.status?.iters ?? 0) / lockSeconds).toFixed(1)),
      inputs: p.inputs,
      wireBytesPerSecond: Math.round(p.wireBytes / lockSeconds),
      messagesPerSecond: Number((p.messages / lockSeconds).toFixed(1)),
    })),
    errors: last?.errors,
  }, null, 2));
  const dd = last?.drift;
  process.exit(dd && dd.compared > 0 && dd.mismatched === 0 ? 0 : 1);
}
console.log(JSON.stringify({
  minutes,
  query,
  drift: last?.drift,
  loads: last?.loads,
  inputs: last?.inputs,
  presses: last?.presses,
  batches: last?.batches,
  wireBytes: last?.wireBytes,
  wireBytesPerSecond: Math.round((last?.wireBytes ?? 0) / seconds),
  snapshotBytes: last?.snapshotBytes,
  distinctHashes: last?.distinctHashes,
  dropped: last?.dropped,
  stalls: last?.stalls,
  lagFrames: { p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? null, samples: sorted.length },
  errors: last?.errors,
}, null, 2));
const d = last?.drift;
process.exit(d && d.compared > 0 && d.mismatched === 0 ? 0 : 1);
