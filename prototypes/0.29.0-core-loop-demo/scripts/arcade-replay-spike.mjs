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
 *        [--screenshot out.png]
 *
 * Exits non-zero when any compared hash differed, nothing was compared, or
 * either frame reported an error (one torn down partway through stops
 * comparing, which no mismatch would show). The negative control,
 * `--query drop=N`, is expected to.
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
await page.goto(`${base}/replay-spike.html${query ? `?${query}` : ''}`);
const read = () => page.evaluate(() => window.__replaySpike?.stats());
const started = Date.now();
const until = started + minutes * 60_000;
let last;
while (Date.now() < until) {
  await page.waitForTimeout(Math.min(30_000, until - Date.now()));
  last = await read();
  const d = last?.drift;
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
process.exit(d && d.compared > 0 && d.mismatched === 0 && !last?.errors?.length ? 0 : 1);
