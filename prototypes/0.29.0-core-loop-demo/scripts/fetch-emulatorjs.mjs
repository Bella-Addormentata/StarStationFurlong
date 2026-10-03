#!/usr/bin/env node
/**
 * 🕹 Fetch EmulatorJS's data files into public/emulatorjs/ for a SOVEREIGN
 * build of the arcade cabinet (#193, plan §9).
 *
 * They are not vendored: the libretro cores run to a few hundred MB. This
 * shallow-clones the EmulatorJS repository (a tag with EJS_VERSION, else its
 * default branch), copies its data/ folder — loader.js, the engine, the
 * cores — next to this prototype's other public files, and records what it
 * took. public/emulatorjs/ is git-ignored. The cabinet's EMULATOR FILES:
 * THIS STATION then works with no third party in the loop; without this
 * the stage shows NOT PROVISIONED, and the room owner may opt a cabinet
 * into cdn.emulatorjs.org (the CONVENIENCE lane) instead.
 *
 *   npm run fetch:emulatorjs
 *   EJS_VERSION=v4.2.1 npm run fetch:emulatorjs
 *
 * Licences to review before shipping a build with these inside: EmulatorJS
 * is GPL-3.0; the cores carry their own (FBNeo has a non-commercial clause,
 * MAME is a GPL-2.0 / BSD-3 mix). Nothing here decides that for you.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'public', 'emulatorjs', 'data');
const version = process.env.EJS_VERSION ?? '';
const repo = process.env.EJS_REPO ?? 'https://github.com/EmulatorJS/EmulatorJS.git';
const log = (s) => console.log(`[fetch-emulatorjs] ${s}`);

const tmp = mkdtempSync(join(tmpdir(), 'emulatorjs-'));
try {
  log(`cloning ${repo}${version ? ` @ ${version}` : ''} (shallow; the cores make it a few hundred MB)…`);
  execFileSync('git', ['clone', '--depth', '1', ...(version ? ['--branch', version] : []), repo, tmp], { stdio: 'inherit' });
  const data = join(tmp, 'data');
  if (!existsSync(join(data, 'loader.js'))) {
    throw new Error('no data/loader.js in the clone — the upstream layout changed; see https://github.com/EmulatorJS/EmulatorJS');
  }
  const cores = existsSync(join(data, 'cores')) ? readdirSync(join(data, 'cores')).filter((f) => f.endsWith('.data')) : [];
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(data, dest, { recursive: true });
  const head = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(dest, '..', 'VERSION'), `${version || 'default-branch'} ${head}\n`);
  log(`${dest} ready (${head.slice(0, 12)}, ${cores.length} core file${cores.length === 1 ? '' : 's'}).`);
  if (cores.length === 0) {
    log('WARNING: data/cores holds no *.data files — this checkout ships the engine without cores. Take the cores from the matching release archive at https://github.com/EmulatorJS/EmulatorJS/releases into public/emulatorjs/data/cores/.');
  }
  log('The cabinet\'s EMULATOR FILES: THIS STATION now works offline (rebuild with `npm run build`).');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
