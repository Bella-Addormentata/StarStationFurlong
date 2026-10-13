#!/usr/bin/env node
/**
 * 🕹 Pack the source of the EmulatorJS a release ships (#193) into one
 * archive, emulatorjs-<version>-source.tar.xz, which release.yml attaches
 * to the release beside the installers that carry the emulator.
 *
 * Release builds carry EmulatorJS and the libretro cores EJS_CORES names, all
 * eleven by default (scripts/fetch-emulatorjs.mjs), and this packs the source
 * of those same cores. The engine and most cores are GPL and
 * mgba is MPL-2.0: whoever ships them must also offer the exact source they
 * were built from, and the plainest way is from the same place. EmulatorJS
 * publishes the cores built but does not say what each was built from, so
 * scripts/emulatorjs-sources.json pins it, each by its full commit hash:
 *   - each core: the commit its own version string names. A libretro core's
 *     version ends in `git rev-parse --short HEAD` of the tree it was built
 *     from (fceumm's wasm says "(SVN) 71013a1"). For ten of the eleven that
 *     is also the newest commit on the default branch when its build began
 *     (cores/reports/<core>.json), as it should be: EmulatorJS's build
 *     clones each core's newest code. pcsx_rearmed's fork was rewritten
 *     after that build, so its commit is on no branch now; GitHub still
 *     serves it by its full hash, and the archive keeps a copy.
 *   - RetroArch, EmulatorJS's fork, which every core is linked with: the
 *     commit its version string names in every core ("40b2c7c").
 *   - EmulatorJS/build, whose build.sh and cores.json built the cores: its
 *     commit at the time, whose build.json (version 2.0.1) every core
 *     archive carries.
 *   - the engine: the commit of its v<version> tag, whose data/ is the npm
 *     package's, file for file.
 *   - the engine's unpacking helpers (data/compression/), files EmulatorJS
 *     has carried prebuilt since 2021, where their source is known (under
 *     `helpers`). libunrar.js and libunrar.wasm are tnikolai2/libunrar-js's
 *     build of RARLAB's UnRAR 5.9.2 (EmulatorJS's data/compression/README.md,
 *     added after 4.2.1, names it): its libunrar.wasm is EmulatorJS's byte
 *     for byte, and its libunrar.js is EmulatorJS's but for a six-line
 *     header. Nothing says what extract7z.js and extractzip.js were built
 *     from, so theirs is the one source the archive cannot carry, and its
 *     README.txt says so.
 * Each tree is fetched by that hash, checked to be that commit, and packed
 * without git's own files. A core's submodules are packed when its web
 * build compiles them, and emulatorjs-sources.json lists those under the
 * core's `submodules`; the others are named in the archive's README.txt,
 * each with its commit, but not packed. For 4.2.1 no core lists any:
 * snes9x's six serve its Windows and Vulkan builds, and pcsx_rearmed's two
 * its own desktop frontend and its JIT, which its web build leaves out
 * (NO_FRONTEND, DYNAREC 0). Two of them live off GitHub (SourceForge,
 * Savannah), which a release would then also depend on.
 *
 *   npm run pack:emulatorjs-source                  (into ./emulatorjs-source/)
 *   EJS_SOURCE_OUT=<dir> npm run pack:emulatorjs-source
 *   EJS_CORES=fceumm,mgba npm run pack:emulatorjs-source   (a subset, as fetched)
 *
 * Needs git, GNU tar and xz. It reads github.com and nothing else.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(join(here, 'emulatorjs-sources.json'), 'utf8'));
const out = resolve(process.env.EJS_SOURCE_OUT || join(here, '..', 'emulatorjs-source'));
const name = `emulatorjs-${sources.version}-source`;
const log = (s) => console.log(`[pack-emulatorjs-source] ${s}`);
// A repository that is gone fails rather than asking for a password.
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf8').trim();

// The cores the build carries, chosen as fetch-emulatorjs.mjs chooses them:
// EJS_CORES when it is set (release.yml sets it once, for both), else every
// pinned core, which are the fetch's own defaults (arcadeDoc.test.ts). A core
// the build leaves out, its source leaves out too.
const cores = [...new Set((process.env.EJS_CORES ? process.env.EJS_CORES.split(',') : Object.keys(sources.cores))
  .map((c) => c.trim()).filter(Boolean))];
for (const core of cores) {
  if (!/^[a-z0-9_]+$/.test(core)) throw new Error(`'${core}' is not a core's name`);
  if (!Object.hasOwn(sources.cores, core)) throw new Error(`core ${core} has no source pinned in emulatorjs-sources.json`);
}
const helpers = Object.entries(sources.helpers ?? {});
for (const [helper] of helpers) {
  if (!/^[a-z0-9_]+$/.test(helper)) throw new Error(`emulatorjs-sources.json: '${helper}' is not a helper's name`);
}
/** Every tree the archive carries: where it goes and what it is. */
const trees = [
  { dir: 'EmulatorJS', what: `the engine, EmulatorJS ${sources.version}`, ...sources.engine },
  { dir: 'RetroArch', what: "RetroArch, EmulatorJS's fork, which every core is linked with", ...sources.frontend },
  { dir: 'build', what: "EmulatorJS's build scripts (build.sh, cores.json), which built the cores", ...sources.build },
  ...cores.map((core) => ({ dir: `cores/${core}`, what: `the ${core} core`, ...sources.cores[core] })),
  ...helpers.map(([helper, s]) => ({ dir: `helpers/${helper}`, what: `the source of the engine's ${helper} (EmulatorJS/data/compression/${helper}.*)`, ...s })),
];

const work = mkdtempSync(join(tmpdir(), 'ejs-source-'));
const top = join(work, name);
try {
  const listed = [];
  let newest = 0;
  for (const t of trees) {
    if (!/^[0-9a-f]{40}$/.test(t.commit ?? '')) throw new Error(`${t.dir}: '${t.commit}' is not a full commit hash`);
    const dir = join(top, t.dir);
    mkdirSync(dir, { recursive: true });
    log(`${t.dir}: ${t.repo} at ${t.commit} …`);
    run('git', ['init', '-q', dir]);
    // A remote, not a bare URL: a submodule's relative URL resolves against it.
    run('git', ['-C', dir, 'remote', 'add', 'origin', t.repo]);
    run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', t.commit]);
    run('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
    const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    if (head !== t.commit) throw new Error(`${t.dir}: checked out ${head}, not ${t.commit}`);
    const wanted = t.submodules ?? [];
    if (wanted.length) run('git', ['-C', dir, 'submodule', 'update', '-q', '--init', '--recursive', '--depth', '1', '--', ...wanted]);
    // Every submodule, packed or not: ' ' is checked out at its commit, '-'
    // left out; '+' or 'U' would be a checkout that is not its commit.
    const hasModules = existsSync(join(dir, '.gitmodules'));
    const subs = hasModules ? run('git', ['-C', dir, 'submodule', 'status', '--recursive']).split('\n').filter(Boolean) : [];
    const bad = subs.filter((l) => /^[+U]/.test(l));
    if (bad.length) throw new Error(`${t.dir}: submodules not at their commits:\n${bad.join('\n')}`);
    // .gitmodules as `submodule.<name>.<key>=<value>` lines; a name need not be its path.
    const modules = hasModules ? run('git', ['-C', dir, 'config', '-f', '.gitmodules', '--list']).split('\n') : [];
    const urlOf = (path) => {
      const key = modules.find((l) => l.endsWith(`.path=${path}`))?.slice('submodule.'.length, -`.path=${path}`.length);
      return modules.find((l) => l.startsWith(`submodule.${key}.url=`))?.slice(`submodule.${key}.url=`.length) ?? '';
    };
    const line = (l) => {
      const [, commit, path] = /^.([0-9a-f]{40}) (\S+)/.exec(l) ?? [];
      return `    ${path} at ${commit}${urlOf(path) ? `, ${urlOf(path)}` : ''}`;
    };
    const packed = subs.filter((l) => l.startsWith(' '));
    const left = subs.filter((l) => l.startsWith('-'));
    newest = Math.max(newest, Number(run('git', ['-C', dir, 'log', '-1', '--format=%ct', 'HEAD'])));
    listed.push([
      `${t.dir}/`, `  ${t.what}`, `  ${t.repo} at ${t.commit}`,
      ...(packed.length ? ['  with these submodules:', ...packed.map(line)] : []),
      ...(left.length ? ['  and these submodules, which its web build does not compile, left out:', ...left.map(line)] : []),
    ].join('\n'));
  }
  // Where these scripts are in the Star Station Furlong repository.
  let scripts = 'scripts';
  try {
    scripts = relative(run('git', ['-C', here, 'rev-parse', '--show-toplevel']), here).split('\\').join('/');
  } catch {
    // not a git checkout: the plain name
  }
  writeFileSync(join(top, 'README.txt'), [
    `The source of EmulatorJS ${sources.version} and the libretro cores that Star Station`,
    "Furlong's release builds carry for the arcade cabinet, each at the commit it",
    'was built from. In https://github.com/Bella-Addormentata/StarStationFurlong,',
    `${scripts}/emulatorjs-sources.json pins those commits,`,
    `and ${scripts}/pack-emulatorjs-source.mjs says how each was found.`,
    'Every directory is its repository at that commit, as git checks it out, without',
    "git's own files, and each carries its own licence. A core's submodules are packed",
    'when its web build compiles them; the others are named below with their commits.',
    'build/build.sh is how EmulatorJS built the cores: it clones RetroArch and each',
    'core, builds the core, and links it with RetroArch.',
    'Two files have no source here: EmulatorJS/data/compression/extract7z.js and',
    'extractzip.js, the 7z and zip unpackers, which EmulatorJS has only ever',
    'published built, since 2021, with nothing to say what they were built from.',
    "The RAR unpacker beside them is helpers/libunrar/'s build (UnRAR 5.9.2's",
    "source is in it, as RARLAB's tarball).",
    '',
    ...listed.map((l) => `${l}\n`),
  ].join('\n'));

  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.tar.xz`);
  const partial = `${file}.partial`;
  log(`packing ${file} …`);
  // Sorted, with one owner and one time for every file.
  try {
    execFileSync('tar', [
      '--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=@${newest}`,
      '--exclude=.git', '-I', 'xz -T0 -6', '-C', work, '-cf', partial, name,
    ], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  renameSync(partial, file);
  log(`${file}: ${(statSync(file).size / 1_048_576).toFixed(1)} MB, ${trees.length} trees.`);
} catch (err) {
  console.error(`[pack-emulatorjs-source] FAILED: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
