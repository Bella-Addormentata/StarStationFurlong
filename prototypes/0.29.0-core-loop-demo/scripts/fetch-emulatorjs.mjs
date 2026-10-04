#!/usr/bin/env node
/**
 * 🕹 Fetch EmulatorJS into public/emulatorjs/ for a SOVEREIGN build of the
 * arcade cabinet (#193, plan §9).
 *
 * Nothing of it is vendored (the libretro cores run to hundreds of MB).
 * Two sources, one pinned version:
 *   - the ENGINE (loader.js, emulator.min.js, its CSS, localization,
 *     compression helpers) from the EmulatorJS repository at the tag
 *     `v<EJS_VERSION>` — the repository ships no core binaries;
 *   - the CORES the cabinet offers (one `<core>-wasm.data` each) from the
 *     EmulatorJS CDN at the SAME version, so engine and cores match.
 *
 * Everything lands in a staging directory first — under public/emulatorjs/
 * itself, so the final move is a rename on one filesystem and not a copy
 * that can fail halfway (the OS temp directory is often another
 * filesystem, where rename throws EXDEV) — and is checked: loader.js
 * present, every core file present and non-empty. Only then is it swapped
 * into place: the old install moves aside, the new one moves in, and if
 * that second move fails the old one is put back. A failed or partial
 * fetch leaves whatever was installed before in place, and says so.
 *
 *   npm run fetch:emulatorjs
 *   EJS_VERSION=4.2.1 npm run fetch:emulatorjs
 *   EJS_CORES=fceumm,snes9x npm run fetch:emulatorjs       (a subset)
 *   EJS_CDN=https://mirror.example/emulatorjs ...          (another host)
 *
 * public/emulatorjs/ is git-ignored. The cabinet's EMULATOR FILES: THIS
 * STATION then works with no third party in the loop; without this the
 * stage shows NOT PROVISIONED, and the room owner may opt a cabinet into
 * cdn.emulatorjs.org (the CONVENIENCE lane, which the cabinet runs in a
 * sandboxed frame) instead.
 *
 * Licences to review before shipping a build with these inside: EmulatorJS
 * is GPL-3.0; the cores carry their own (FBNeo has a non-commercial clause,
 * MAME is a GPL-2.0 / BSD-3 mix). Nothing here decides that for you.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'public', 'emulatorjs');
const dest = join(root, 'data');
/** The documented release at the time of writing; override to pin another. */
const version = (process.env.EJS_VERSION ?? '4.2.1').replace(/^v/, '');
const repo = process.env.EJS_REPO ?? 'https://github.com/EmulatorJS/EmulatorJS.git';
const cdn = (process.env.EJS_CDN ?? 'https://cdn.emulatorjs.org').replace(/\/+$/, '');
/** The libretro cores behind the systems the cabinet offers (arcadeDoc.ts
 *  ARCADE_CORES): nes → fceumm, snes → snes9x, gb/gbc → gambatte, gba → mgba,
 *  segaMD/segaMS → genesis_plus_gx, n64 → mupen64plus_next, arcade → fbneo,
 *  mame2003 → mame2003_plus, psx → pcsx_rearmed, atari2600 → stella2014,
 *  pce → mednafen_pce. The plain `-wasm.data` build of each: the threaded
 *  variants need COOP/COEP headers this app does not send. */
const DEFAULT_CORES = [
  'fceumm', 'snes9x', 'gambatte', 'mgba', 'genesis_plus_gx', 'mupen64plus_next',
  'fbneo', 'mame2003_plus', 'pcsx_rearmed', 'stella2014', 'mednafen_pce',
];
const cores = (process.env.EJS_CORES ? process.env.EJS_CORES.split(',') : DEFAULT_CORES)
  .map((c) => c.trim()).filter(Boolean);
const log = (s) => console.log(`[fetch-emulatorjs] ${s}`);
/** A failure is thrown, not exited on: the cleanup below must run first
 *  (process.exit would skip the `finally`, leaving staging behind). */
class Failure extends Error {}
const fail = (why) => {
  throw new Failure(why);
};

async function download(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${url} → empty`);
  writeFileSync(to, bytes);
  return bytes.length;
}

// The clone may live anywhere (it is only copied from); the staging tree
// lives beside its destination, on the same filesystem, so the swap below
// is two renames and never a copy.
const tmp = mkdtempSync(join(tmpdir(), 'emulatorjs-'));
const clone = join(tmp, 'repo');
mkdirSync(root, { recursive: true });
const staging = mkdtempSync(join(root, '.staging-'));
/** '' until the swap; dest once the new tree is in; 'lost' when the old
 *  tree could not be put back after a failed swap (it is at dest.prev). */
let installed = '';
try {
  log(`engine: cloning ${repo} @ v${version} (shallow)…`);
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', `v${version}`, repo, clone], { stdio: 'inherit' });
  } catch (err) {
    fail(`the engine clone at tag v${version} did not succeed (${err.message}). Is EJS_VERSION a published tag?`);
  }
  if (!existsSync(join(clone, 'data', 'loader.js'))) {
    fail('no data/loader.js in the clone — the upstream layout changed; see https://github.com/EmulatorJS/EmulatorJS');
  }
  cpSync(join(clone, 'data'), staging, { recursive: true });
  const coresDir = join(staging, 'cores');
  mkdirSync(coresDir, { recursive: true });
  log(`cores: ${cores.length} from ${cdn}/${version}/data/cores/ …`);
  let total = 0;
  for (const core of cores) {
    const file = `${core}-wasm.data`;
    const url = `${cdn}/${version}/data/cores/${file}`;
    try {
      const n = await download(url, join(coresDir, file));
      total += n;
      log(`  ${file}: ${(n / 1_048_576).toFixed(1)} MB`);
    } catch (err) {
      fail(`core ${core}: ${err.message}`);
    }
  }
  // Check the staging tree before anything is swapped in.
  for (const core of cores) {
    const p = join(coresDir, `${core}-wasm.data`);
    if (!existsSync(p) || statSync(p).size === 0) fail(`core file missing or empty after download: ${p}`);
  }
  if (!existsSync(join(staging, 'loader.js'))) fail('loader.js missing from the staging tree');
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
  const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(root, 'VERSION'), `v${version} ${head}\ncores: ${cores.join(', ')}\n`);
  log(`${dest} ready: v${version} (${head.slice(0, 12)}), ${cores.length} cores, ${(total / 1_048_576).toFixed(0)} MB of cores.`);
  log('The cabinet\'s EMULATOR FILES: THIS STATION now works offline (rebuild with `npm run build`).');
} catch (err) {
  console.error(`[fetch-emulatorjs] FAILED: ${err instanceof Failure ? err.message : (err && err.stack) || err}`);
  if (!installed) console.error('[fetch-emulatorjs] the install under public/emulatorjs/data is as it was.');
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true }); // already gone after a successful swap
}
