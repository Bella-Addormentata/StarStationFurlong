#!/usr/bin/env node
/**
 * 🕹 Fetch EmulatorJS into public/emulatorjs/ for a SOVEREIGN build of the
 * arcade cabinet (#193, plan §9).
 *
 * Nothing of it is vendored (the libretro cores run to hundreds of MB).
 * One source, one pinned version: the npm registry this app already
 * installs from, where EmulatorJS publishes both halves —
 *   - the ENGINE (loader.js, its scripts and CSS, localization,
 *     compression helpers) from @emulatorjs/emulatorjs@<EJS_VERSION>;
 *   - each CORE the cabinet offers from @emulatorjs/core-<core> at the
 *     SAME version, so engine and cores match: its report
 *     (cores/reports/<core>.json) and the two builds EmulatorJS picks
 *     between without threads: `<core>-legacy-wasm.data`, which it loads
 *     unless WebGL 2 is switched on (its report's default, or its own
 *     menu), and `<core>-wasm.data`, when it is. The threaded builds need
 *     COOP/COEP headers this app does not send.
 * Every tarball is checked against the sha512 the registry publishes for
 * it, and against the one pinned in PINNED below where there is one (what
 * a release ships). release.yml sets EJS_REQUIRE_PIN=1, which refuses any
 * package without a pin, or without the commit it was built from in
 * emulatorjs-sources.json, so a release carries exactly those bytes and
 * can name their source.
 *
 * Everything lands in a staging directory first — under public/emulatorjs/
 * itself, so the final move is a rename on one filesystem and not a copy
 * that can fail halfway (the OS temp directory is often another
 * filesystem, where rename throws EXDEV) — and is checked: loader.js
 * present, every core's report and builds present and non-empty. Only then
 * is it swapped into place: the old install moves aside, the new one moves
 * in, and if that second move fails the old one is put back. A failed or
 * partial fetch leaves whatever was installed before in place, and says so.
 *
 *   npm run fetch:emulatorjs
 *   EJS_VERSION=4.2.1 npm run fetch:emulatorjs
 *   EJS_CORES=fceumm,snes9x npm run fetch:emulatorjs       (a subset)
 *   EJS_REQUIRE_PIN=1 npm run fetch:emulatorjs             (a release)
 *
 * The registry is npm's own setting (npm_config_registry, which `npm run`
 * passes down), else https://registry.npmjs.org/.
 *
 * public/emulatorjs/ is git-ignored. The cabinet's EMULATOR FILES: THIS
 * STATION then works with no third party in the loop; without this the
 * stage shows NOT PROVISIONED, and the room owner may opt a cabinet into
 * cdn.emulatorjs.org (the CONVENIENCE lane, which the cabinet runs in a
 * sandboxed frame) instead.
 *
 * Licences: EmulatorJS is GPL-3.0 (its LICENSE lands beside the engine);
 * each core carries its own inside its archive (license.txt; stella2014's
 * carries none), and public/arcade/licenses/ has them as text. FBNeo,
 * MAME 2003-Plus, Snes9x and Genesis Plus GX forbid commercial use.
 * NOTICE.txt, written beside the engine, names what was fetched and the
 * commit each part was built from (emulatorjs-sources.json). Release builds
 * ship the cores release.yml's EJS_CORES names (every default core unless it
 * names fewer), and each release carries their source too, as
 * emulatorjs-<version>-source.tar.xz beside the installers
 * (pack-emulatorjs-source.mjs packs it, for the same EJS_CORES).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'public', 'emulatorjs');
const dest = join(root, 'data');
/** The documented release at the time of writing; override to pin another. */
const version = (process.env.EJS_VERSION ?? '4.2.1').replace(/^v/, '');
const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/*$/, '/');
/** The libretro cores behind the systems the cabinet offers, exactly the
 *  ones it names to EmulatorJS (arcadeDoc.ts ARCADE_CORES, `libretro`;
 *  arcadeDoc.test.ts holds the two together): nes → fceumm, snes → snes9x,
 *  gb/gbc → gambatte, gba → mgba, segaMD/segaMS → genesis_plus_gx,
 *  n64 → mupen64plus_next, arcade → fbneo, mame2003 → mame2003_plus,
 *  psx → pcsx_rearmed, atari2600 → stella2014, pce → mednafen_pce. */
const DEFAULT_CORES = [
  'fceumm', 'snes9x', 'gambatte', 'mgba', 'genesis_plus_gx', 'mupen64plus_next',
  'fbneo', 'mame2003_plus', 'pcsx_rearmed', 'stella2014', 'mednafen_pce',
];
/** The tarballs a release ships (release.yml: every default core at 4.2.1),
 *  pinned by the sha512 the registry published for them: a tarball that
 *  differs fails the fetch even if the registry now vouches for it. */
const PINNED = {
  '@emulatorjs/emulatorjs@4.2.1': 'sha512-l19m9jg2ZLGsZVL8XQ1LUqoa5LE9mKlZm3dPtNuovQKhirqdNxg3/tJlvny6P7PgcBrUeyQJzy01DUq4AFMl9A==',
  '@emulatorjs/core-fceumm@4.2.1': 'sha512-lRqxYLlCZH0iqCtE6cJ4eXl88vmNSSrlyBaE4o4vD0mo3HJ4eRCTDSCLUZd7hDJTW1l7IRZlKJO19WqTrD9a4A==',
  '@emulatorjs/core-snes9x@4.2.1': 'sha512-ANQufL7fB6lidukvRA0bcieg7VSQN4BvmwCsVGtHiNfp9viQLwXz3gADr5USIOqqs3vkzBwbJEf3iw64Xs9A3A==',
  '@emulatorjs/core-gambatte@4.2.1': 'sha512-9y4/lVMpia5zMgiIW/JGRvTAJFtL2IzmYunEg3IedZJMocYgF7yUKM4NU6X0usuesKNRGsekw/yYP/g485sU4A==',
  '@emulatorjs/core-mgba@4.2.1': 'sha512-dcYKBxQUhg/QrxD7a3tPaOjG191dudgKVlnHcm2gBC12JraBHgPkRQJiwbEKvKtrTWr09M0FV+A8iKPB8QgVOQ==',
  '@emulatorjs/core-genesis_plus_gx@4.2.1': 'sha512-H1UONBeoBLdEDaT1TXC6D/i82v0/vlknTkkETlpLp7YZTmbphX+WhnjF+KBohC4IX7WMh6AivPrxyZTDFEmRFA==',
  '@emulatorjs/core-mupen64plus_next@4.2.1': 'sha512-tR8EAGii9oN/Ov7fDa7E0MARkt2fLmJVK/WzvQh9plL/6huMXU5SaqBToPQMyoZHWqnjbwgORSlLtpdoESUFyw==',
  '@emulatorjs/core-fbneo@4.2.1': 'sha512-iV25lBZHhkAzmKNnUXsVa1jE9YO4pIVQyoLHipVWlDKg4V52uYD+tyKIKWVZnxOT5B3twOqMSDBMzOw5MXva/Q==',
  '@emulatorjs/core-mame2003_plus@4.2.1': 'sha512-mjpMBdLPiyG5DupJ2qKUXmuyfSYWV1ANIr/5kMEJNqWLpGoY0NbDLc/hDGx27PwG38oey4PRmks4ZNhCRwHqUQ==',
  '@emulatorjs/core-pcsx_rearmed@4.2.1': 'sha512-hlIMwdCGrppxRmMq4jgCrwwURLCc+k5y+M99G+l0Uifz+IubK+eqvmR+17oWPcbJB/h0Cc6Eo8QRShj3B4LutA==',
  '@emulatorjs/core-stella2014@4.2.1': 'sha512-bbqre/PwCuOaw1F9tyySlzHDE6b9mgbrwB6CFXXkjxYf9U5Y2PdttQQQsJS8mbJ72kEmKD4mNTR4W4XrdGa6nQ==',
  '@emulatorjs/core-mednafen_pce@4.2.1': 'sha512-HEph8cT5Q3EPxBBv+KsO8/3okN7t5IIw/WhPPkMPcwQZZyWPE+oaU2f6BUsaui3wXuJmD5D45MxzXLA0G01ZXg==',
};
const cores = (process.env.EJS_CORES ? process.env.EJS_CORES.split(',') : DEFAULT_CORES)
  .map((c) => c.trim()).filter(Boolean);
/** The commit each part of a pinned version was built from. */
const sources = JSON.parse(readFileSync(join(here, 'emulatorjs-sources.json'), 'utf8'));
const sourced = sources.version === version;
const log = (s) => console.log(`[fetch-emulatorjs] ${s}`);
/** A failure is thrown, not exited on: the cleanup below must run first
 *  (process.exit would skip the `finally`, leaving staging behind). */
class Failure extends Error {}
const fail = (why) => {
  throw new Failure(why);
};

async function get(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // Node's own fetch ignores HTTPS_PROXY unless told to.
    const hint = process.env.HTTPS_PROXY || process.env.https_proxy ? ' (behind a proxy: NODE_USE_ENV_PROXY=1, Node 22.21 or later)' : '';
    throw new Error(`${url} → ${err.cause?.message ?? err.message}${hint}`);
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The files of a package tarball (gzipped ustar, as npm publishes it):
 *  path → bytes, regular files only. A pax header's path names the entry
 *  after it (node-tar writes one for a name past 100 bytes). */
function untar(tgz) {
  const buf = gunzipSync(tgz);
  const files = new Map();
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => {
      const s = h.subarray(a, b);
      const z = s.indexOf(0);
      return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
    };
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size)) fail('a tarball entry has no readable size');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = field(345, 500);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = null;
    // Nothing may land outside where it is put.
    if (name.startsWith('/') || name.includes('\\') || /(^|\/)\.\.(\/|$)/.test(name)) fail(`a tarball entry escapes its folder: ${name}`);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === 'x') paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    else if (type === '0' || type === '7') files.set(name, Buffer.from(body));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** One package's files, checked against the registry's sha512 and the pin. */
async function fetchPackage(name) {
  const spec = `${name}@${version}`;
  let meta;
  try {
    meta = JSON.parse((await get(`${registry}${name.replace('/', '%2f')}/${version}`)).toString('utf8'));
  } catch (err) {
    fail(`${spec}: no such version on ${registry} (${err.message})`);
  }
  const published = meta?.dist?.integrity;
  const tarball = meta?.dist?.tarball;
  if (typeof published !== 'string' || !published.startsWith('sha512-') || typeof tarball !== 'string') {
    fail(`${spec}: the registry gives no sha512 for it`);
  }
  const pinned = PINNED[spec];
  if (pinned && pinned !== published) fail(`${spec}: the registry's sha512 is not the pinned one`);
  if (!pinned && process.env.EJS_REQUIRE_PIN === '1') fail(`${spec} is not pinned (EJS_REQUIRE_PIN=1): add the sha512 it should have to PINNED`);
  const tgz = await get(tarball);
  const actual = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  if (actual !== published) fail(`${spec}: the tarball does not match its sha512`);
  return { spec, integrity: actual, files: untar(tgz), repository: meta.repository?.url ?? '' };
}

function put(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

mkdirSync(root, { recursive: true });
const staging = mkdtempSync(join(root, '.staging-'));
/** '' until the swap; dest once the new tree is in; 'lost' when the old
 *  tree could not be put back after a failed swap (it is at dest.prev). */
let installed = '';
try {
  if (process.env.EJS_REQUIRE_PIN === '1') {
    if (!sourced) fail(`no source is pinned for EmulatorJS ${version} (EJS_REQUIRE_PIN=1): emulatorjs-sources.json is for ${sources.version}`);
    for (const core of cores) {
      if (!sources.cores[core]) fail(`core ${core} has no source pinned (EJS_REQUIRE_PIN=1): add the commit it was built from to emulatorjs-sources.json`);
    }
  }
  log(`engine: @emulatorjs/emulatorjs@${version} from ${registry} …`);
  const engine = await fetchPackage('@emulatorjs/emulatorjs');
  let engineFiles = 0;
  for (const [path, bytes] of engine.files) {
    if (!path.startsWith('package/data/')) continue;
    put(join(staging, path.slice('package/data/'.length)), bytes);
    engineFiles++;
  }
  if (!existsSync(join(staging, 'loader.js'))) {
    fail('no data/loader.js in the engine package — the upstream layout changed; see https://github.com/EmulatorJS/EmulatorJS');
  }
  const license = engine.files.get('package/LICENSE');
  if (!license) fail('the engine package carries no LICENSE');
  put(join(staging, 'LICENSE'), license);
  // The package has no emulator.min.js or emulator.min.css, which loader.js
  // asks for first, loading the scripts under src/ one by one when that
  // fails. The desktop app answers a missing file with its index.html, not
  // a 404, so there nothing fails and the engine never loads. The two files
  // are written here as data/minify/index.js builds them, its scripts in its
  // order inside one function, minus the minifying.
  const order = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js'];
  const parts = order.map((file) => engine.files.get(`package/data/src/${file}`) ?? fail(`the engine package has no src/${file}`));
  const css = engine.files.get('package/data/emulator.css') ?? fail('the engine package has no emulator.css');
  put(join(staging, 'emulator.min.js'), `(function() {\n${parts.map((b) => b.toString('utf8')).join('\n')}\n\n})();`);
  put(join(staging, 'emulator.min.css'), css);
  log(`  ${engineFiles} files, and emulator.min.js and emulator.min.css from them`);

  const coresDir = join(staging, 'cores');
  const fetched = [];
  let total = 0;
  for (const core of cores) {
    const pkg = await fetchPackage(`@emulatorjs/core-${core}`);
    const wanted = [`${core}-legacy-wasm.data`, `${core}-wasm.data`, `reports/${core}.json`];
    for (const file of wanted) {
      const bytes = pkg.files.get(`package/${file}`);
      if (!bytes || bytes.length === 0) fail(`core ${core}: ${file} missing from ${pkg.spec}`);
      put(join(coresDir, file), bytes);
      if (file.endsWith('.data')) total += bytes.length;
    }
    fetched.push({ ...pkg, core });
    log(`  ${core}: ${pkg.spec}`);
  }
  // Check the staging tree before anything is swapped in.
  for (const core of cores) {
    for (const file of [`${core}-legacy-wasm.data`, `${core}-wasm.data`, `reports/${core}.json`]) {
      const p = join(coresDir, file);
      if (!existsSync(p) || statSync(p).size === 0) fail(`core file missing or empty after download: ${p}`);
    }
  }
  if (!existsSync(join(staging, 'loader.js'))) fail('loader.js missing from the staging tree');
  /** Where a core's source is: the commit it was built from, else its repository. */
  const sourceOf = (p) => {
    const s = sourced ? sources.cores[p.core] : null;
    if (s) return `, built from ${s.repo} at ${s.commit}`;
    return p.repository ? `, source ${p.repository.replace(/^git\+/, '').replace(/\.git$/, '')}` : '';
  };
  writeFileSync(join(staging, 'NOTICE.txt'), [
    'EmulatorJS for the arcade cabinet, as scripts/fetch-emulatorjs.mjs fetched it',
    `from ${registry}. Each package's sha512 is the one the registry publishes.`,
    '',
    `Engine: ${engine.spec} (${engine.integrity})`,
    '  EmulatorJS, GPL-3.0: the licence text is LICENSE, beside this file. Its',
    '  scripts are here unminified, under src/; its repository is',
    `  https://github.com/EmulatorJS/EmulatorJS (tag v${version}${sourced ? `, commit ${sources.engine.commit}` : ''}).`,
    '  emulator.min.js and emulator.min.css are those scripts and emulator.css,',
    '  joined as its minify/index.js joins them but not minified. compression/ holds',
    "  EmulatorJS's prebuilt 7z, zip and RAR unpackers.",
    ...(sourced && sources.helpers?.libunrar ? [
      "  libunrar.js and libunrar.wasm are RARLAB's UnRAR built for the web (UnRAR's",
      `  licence), from ${sources.helpers.libunrar.repo} at`,
      `  ${sources.helpers.libunrar.commit}; nothing says what extract7z.js and`,
      '  extractzip.js were built from.',
    ] : []),
    '',
    'Cores: each <core>-*.data is an archive holding a RetroArch build of a',
    '  libretro core, its source repository (core.json) and its licence',
    "  (license.txt; stella2014's archive has none). EmulatorJS builds them with",
    '  https://github.com/EmulatorJS/build.',
    ...fetched.map((p) => `  ${p.spec} (${p.integrity})${sourceOf(p)}`),
    '',
    ...(sourced ? [
      'Source: each core above is linked with RetroArch, built from',
      `  ${sources.frontend.repo} at ${sources.frontend.commit},`,
      `  by EmulatorJS's build scripts, ${sources.build.repo} at`,
      `  ${sources.build.commit}. A Star Station Furlong release carries`,
      `  all of that source, the engine's and libunrar's too, as`,
      `  emulatorjs-${version}-source.tar.xz beside its installers`,
      '  (scripts/pack-emulatorjs-source.mjs packs it; its README.txt lists every commit).',
      '',
    ] : [
      `Source: no commits are pinned for EmulatorJS ${version} (scripts/emulatorjs-sources.json`,
      `  is for ${sources.version}); each repository above has its source.`,
      '',
    ]),
  ].join('\n'));
  // The swap: the old install moves aside, the new one moves in (a rename
  // on the same filesystem), the old one goes. A failure of the second
  // move puts the old install back before anything is said — the station
  // is never left with no emulator files at all; a crash between the two
  // renames leaves `.prev` to recover by hand.
  const prev = `${dest}.prev`;
  rmSync(prev, { recursive: true, force: true });
  const had = existsSync(dest);
  if (had) renameSync(dest, prev);
  try {
    renameSync(staging, dest);
  } catch (err) {
    let restored = !had;
    if (had) {
      try {
        renameSync(prev, dest);
        restored = true;
      } catch (back) {
        installed = 'lost';
        console.error(`[fetch-emulatorjs] the previous install could not be put back either (${back.message}); it is at ${prev}`);
      }
    }
    fail(`could not move the new files into place (${err.message})${restored ? '; the previous install is as it was' : ''}.`);
  }
  installed = dest;
  rmSync(prev, { recursive: true, force: true });
  writeFileSync(join(root, 'VERSION'), `v${version} ${engine.integrity}\ncores: ${cores.join(', ')}\n`);
  log(`${dest} ready: v${version}, ${cores.length} cores, ${(total / 1_048_576).toFixed(1)} MB of cores.`);
  log('The cabinet\'s EMULATOR FILES: THIS STATION now works offline (rebuild with `npm run build`).');
} catch (err) {
  console.error(`[fetch-emulatorjs] FAILED: ${err instanceof Failure ? err.message : (err && err.stack) || err}`);
  if (!installed) console.error('[fetch-emulatorjs] the install under public/emulatorjs/data is as it was.');
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true }); // already gone after a successful swap
}
