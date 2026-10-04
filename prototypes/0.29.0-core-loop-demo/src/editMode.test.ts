/**
 * 🔒 editMode — every room-doc write goes through the owner gate (source scan)
 *
 * Five writers in editMode.ts were never re-authorised: writeDoorLayout twice
 * (add, drag-commit), writeWindowLayout twice (add, resize) and writeWallpaper.
 * Three others were, each with its own hand-written refusal — which is how the
 * other five came to be missed. The fix routed all eight through one helper,
 * and this is the test that keeps the ninth from slipping past: it fails if a
 * method that calls a room-doc writer is not itself gated and is not reached
 * only from methods that are. Since #184 that covers the file's module-scope
 * functions too — `settleCupolaConflicts` writes the floor plan from outside
 * the class, and a class-only model could only say it had never looked.
 *
 * ⚠️ Like roomOwner.test.ts's #142 block, this SCANS THE SOURCE. editMode.ts
 * cannot be imported here — it touches `window` and THREE at module scope, and
 * these tests run in plain Node with no DOM. So this pins the WIRING (which
 * method asks, and which methods can reach a write without asking), not that a
 * particular click is refused at runtime. That is the weaker of the two claims,
 * and it is the one that catches the failure that actually happened: a new
 * writer added to a method nobody thought to gate.
 *
 * ⚠️ What it still cannot see, stated so nobody reads a pass as more than it
 * is. It matches text, so it believes a gate and a write in the same method
 * are on the same path even when they sit in mutually exclusive branches —
 * it checks the gate comes FIRST, which is necessary and not sufficient. It
 * knows only the writers in WRITERS below, so a write reached indirectly
 * through another module (`world.removeFurnitureVisuals`, say) is invisible
 * to it; the import-surface test is the thing that makes a new name get
 * noticed. It keys the call graph on each declaration's offset, so two units
 * sharing a name stay apart — `isEditModeActive` is both a method and a
 * module-scope function here — but it still matches call sites textually and
 * so cannot follow a call made through a variable.
 *
 * It is also worth saying plainly what the gate is NOT. Nothing authorises a
 * room-doc write today — roomOwner.ts says so outright — so a modified client
 * ignores every check counted here. This is UI correctness for honest clients.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'editMode.ts'), 'utf8');

/**
 * The functions that mutate a shared room doc. Reviewed by hand rather than
 * sniffed from a name pattern, because this list is the security boundary —
 * and the import-surface test below fails if a name arrives or leaves without
 * someone deciding which side of the line it falls on.
 */
const WRITERS = [
  'writeFurnitureItem', 'deleteFurnitureItem', // furnitureDoc
  'writeDoorLayout', 'deleteDoorLayout', 'seedDoorLayoutDefaults', // doorLayoutDoc
  'writeWindowLayout', 'deleteWindowLayout', // windowLayoutDoc
  'writeWallpaper', // wallpaperLayoutDoc
  'writeAirHockeyTheme', // airHockeyThemeDoc
  'addToRoomInventory', // roomInventory
  'clearDoorSlide', // floorPlanDoc — planMap.delete inside a transact
  'writeCupolaWall', // floorPlanDoc — planMap.set/delete inside a transact
] as const;

/** Both forms of gate: the shared helper, and the raw predicate it wraps. */
const GATES = ['this.mayWriteRoomDoc()', 'canEditRoom()'];

/**
 * Comments name writers too (method docs especially) — strip them first.
 *
 * Blanked rather than deleted, so an offset into the stripped text is still
 * an offset into the original. Two things here depend on that: slice bounds
 * are measured on SRC and compared against matches found in stripped text,
 * and `lineAt` has to keep reporting the line a reader can go and look at.
 */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

/**
 * Every member of RoomEditController, sliced from its declaration to the next
 * one. Nearly all of them carry an explicit accessibility modifier; the
 * constructor is the one that cannot, so it is matched by name. Missing a
 * member is not a harmless gap — the slice runs to the NEXT match, so an
 * unmatched method is absorbed into whatever was declared above it, and its
 * calls and its gates are credited to that name instead. That is exactly what
 * happened before this line changed: `constructor` went unmatched, so its 150
 * lines folded into the field `lastPointer` declared two lines above it, and
 * a data field was recorded as holding an owner check. 'finds every member'
 * below is the canary that keeps the next one from going quiet.
 */
const MEMBER_RE =
  /^ {2}(?:(?:public|private|protected) (?:static )?(?:readonly )?(?:async )?([A-Za-z_$][\w$]*)|(constructor)\b)/gm;

/**
 * Where the constructor registers a listener. Each of these is a separate
 * path from user input into the class, reached at an arbitrary later time, so
 * each is sliced out as its own entry point rather than sharing the
 * constructor's. Sharing is not a technicality: a gate in one handler would
 * otherwise be credited to every other handler, and the constructor's own
 * `canEditRoom()` — which belongs to the right-click handler — would vouch
 * for all ten of them. Only the constructor is cut this way; listeners
 * registered inside a method already belong to a method the scan can see.
 */
const LISTENER_RE = /^ {4}[\w.?]+\.addEventListener\(\s*'([\w-]+)'/gm;

const lineAt = (index: number): number => SRC.slice(0, index).split('\n').length;

/**
 * The class body as a half-open [classAt, classEnd) range over SRC.
 *
 * Both ends earn their keep. Cutting members out of the whole file would let
 * a two-space `private` in some module-scope declaration pass for a method;
 * and `cut` runs its last slice to the end of whatever it is handed, so a
 * final member measured against the file would also own everything written
 * after the closing brace — today the `roomEdit` singleton and
 * `isEditModeActive`, whose calls are not that member's to answer for.
 */
const classAt = SRC.indexOf('\nclass RoomEditController {');
const classEnd = SRC.indexOf('\n}', classAt);

/**
 * A named region of source the scan can look inside. `kind` is not
 * decoration: it decides how the unit is CALLED, and therefore how the call
 * graph below finds its callers — `this.foo(` for a member, bare `foo(` for a
 * module-scope function.
 */
type Unit = {
  name: string; body: string; callBody: string;
  start: number; end: number; kind: 'member' | 'function';
};

/**
 * A declaration is not a call, and the two look identical to a text scan:
 * `public enter(` reads as a bare `enter(`, which would make that member a
 * caller of any module-scope function also named `enter` — and so lend it
 * the member's gate. Every unit opens with its own declaration, so blank
 * that span for call-graph purposes. Blanked, not cut, so offsets still
 * line up, and only on the copy the graph reads: writes and gates are still
 * matched against the untouched body, because a false positive there fails
 * loudly while a false caller edge quietly manufactures coverage.
 */
const blankDecl = (body: string, decl: string): string =>
  (decl.length > 0 ? ' '.repeat(decl.length) + body.slice(decl.length) : body);

/** [start, end) slices of the source, named for whatever declared them. */
const cut = (text: string, offset: number, re: RegExp, name: (m: RegExpMatchArray) => string) => {
  const hits = [...text.matchAll(re)];
  return hits.map((h, i) => ({
    name: name(h),
    raw: h[0],
    start: offset + (h.index ?? 0),
    end: offset + (i + 1 < hits.length ? (hits[i + 1].index ?? text.length) : text.length),
  }));
};

const members: Unit[] = [];
for (const m of cut(SRC.slice(classAt, classEnd), classAt, MEMBER_RE, (h) => h[1] ?? h[2])) {
  // The constructor is replaced by its prologue plus one slice per listener,
  // named for the event and the line so a failure says which handler.
  const listeners = m.name === 'constructor'
    ? cut(SRC.slice(m.start, m.end), m.start, LISTENER_RE, (h) => `'${h[1]}' listener`)
    : [];
  const parts = listeners.length > 0
    ? [{ ...m, end: listeners[0].start }, ...listeners]
    : [m];
  for (const p of parts) {
    const name = p.name.endsWith('listener')
      ? `constructor's ${p.name} at line ${lineAt(p.start)}`
      : p.name;
    const body = stripComments(SRC.slice(p.start, p.end));
    // A listener slice opens at its addEventListener line — code, not a
    // declaration, and often carrying a real call — so nothing is blanked.
    const decl = p.name.endsWith('listener') ? '' : p.raw;
    members.push({ ...p, name, kind: 'member', body, callBody: blankDecl(body, decl) });
  }
}

/**
 * Module-scope functions, sliced the same way and held to the same rule.
 *
 * Until #184 there were no room-doc writes outside the class, and this file
 * modelled the class alone. `settleCupolaConflicts` ended that: it is a
 * top-level `export function` that clears a cupola two players conflicted
 * over, so it writes the floor plan, and a member-based scan could only
 * report it as a write it had never looked at — which is exactly what the
 * homeless check below did say when the cupola work merged. Exempting it
 * would have been the wrong repair. main.ts calls it after every floor-plan,
 * door, window and furniture change and once on join, which is the shape of
 * entry point this file exists to check; so the model grew to cover it, and
 * the gate it carries is now asserted rather than remembered.
 *
 * Unlike members these are brace-matched rather than cut to the next
 * declaration: a top-level `function` opens at column 0 and closes at column
 * 0, so the slice is the body and nothing else. That deliberately leaves the
 * consts and types written between two functions inside neither of them —
 * module scope is not inside anything, and a write there must stay homeless.
 */
const FREE_RE = /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/gm;

const functions: Unit[] = [...SRC.matchAll(FREE_RE)].map((h) => {
  const start = h.index ?? 0;
  const close = SRC.indexOf('\n}', start);
  const end = close < 0 ? SRC.length : close + 2;
  const body = stripComments(SRC.slice(start, end));
  return {
    name: h[1], start, end, kind: 'function' as const, body, callBody: blankDecl(body, h[0]),
  };
});

/** Everything the scan can see inside. Anything else is module scope. */
const units: Unit[] = [...members, ...functions];

/**
 * A unit's identity, which is NOT its name. `isEditModeActive` is both a
 * method and the module-scope function main.ts calls to reach it, and the
 * two must be separate nodes in the graph below: keyed by name, a gate on
 * either would vouch for the other. Members can collide with each other the
 * same way, which this file used to list as a limitation and no longer has
 * to. The declaration offset is what makes the key unique.
 */
const idOf = (u: Unit): string => `${u.kind}:${u.name}@${u.start}`;

/**
 * How a unit is reached from inside this file: `this.foo(` for a member, a
 * bare `foo(` for a module-scope function. The lookbehind carries the whole
 * distinction — without it `roomEdit.isEditModeActive()` and
 * `this.isEditModeActive()` would both read as calls to the free function.
 */
const callPattern = (u: Unit): RegExp => (u.kind === 'member'
  ? new RegExp(`\\bthis\\.${u.name}\\s*\\(`)
  : new RegExp(`(?<![.\\w$])${u.name}\\s*\\(`));

const bodyOf = (name: string): string =>
  members.filter((m) => m.name === name).map((m) => m.body).join('\n');

describe('edit mode: no room-doc write without a live owner check (source scan)', () => {
  it('finds the class at all, so a silent zero-method pass is impossible', () => {
    // Every assertion below is vacuously true on an empty member list. This is
    // the canary for a refactor that changes how members are declared.
    expect(members.length).toBeGreaterThan(100);
    for (const n of ['enter', 'exit', 'commitCarry', 'removeSelected', 'mayWriteRoomDoc']) {
      expect(members.some((m) => m.name === n), `${n} not found in editMode.ts`).toBe(true);
    }
  });

  it('finds EVERY member, because one it misses is one credited to its neighbour', () => {
    // The assertion the comment on MEMBER_RE used to claim and the file did
    // not actually make. A member the regex skips is not skipped — it is
    // merged into the slice above it, which is worse than skipping, because
    // the merged-in gates and calls are then attributed to the wrong name.
    //
    // So: inside the class body, every line at member indentation that opens
    // a declaration must be the start of a slice. `#private` fields and bare
    // `name() {}` methods are the two forms that would slip through MEMBER_RE
    // today; this says so out loud rather than waiting to find out.
    expect(classAt, 'class RoomEditController not found').toBeGreaterThan(0);
    expect(classEnd, 'class RoomEditController never closes at column 0')
      .toBeGreaterThan(classAt);
    const starts = new Set(members.map((m) => m.start));
    const unmatched: string[] = [];
    for (const m of SRC.slice(classAt, classEnd).matchAll(/^ {2}[A-Za-z_$#][^\n]*/gm)) {
      const at = classAt + (m.index ?? 0);
      if (!starts.has(at)) unmatched.push(`line ${lineAt(at)}: ${m[0].trim()}`);
    }
    expect(unmatched, `MEMBER_RE missed these, so they folded into the slice above:\n${
      unmatched.join('\n')}`).toEqual([]);

    // Said the other way round, without depending on a member's name: no
    // slice may contain a second member's declaration. This follows from the
    // list above being empty, and is asserted separately because it is the
    // property that actually matters and the cheaper one to read.
    const swallowed = members
      .filter((m) => /\n {2}(?:public|private|protected|constructor)\b/.test(m.body))
      .map((m) => `${m.name} (line ${lineAt(m.start)}) contains another member's declaration`);
    expect(swallowed, swallowed.join('\n')).toEqual([]);

    // And the constructor really was broken out into its handlers. Ten of
    // them today; the count is not pinned, only that the split happened.
    expect(members.filter((m) => m.name.startsWith("constructor's")).length,
      'the constructor was not split into its listeners').toBeGreaterThan(5);
  });

  it('finds every module-scope function, and slices each one to its own body', () => {
    // The free half's equivalent of 'finds EVERY member', and it matters for
    // the same reason: a slice that ran long would lend its gate to whatever
    // followed, and a function the regex missed would have its writes come
    // back as homeless rather than as a leak — a quieter failure than it
    // sounds, because homeless is a list nobody expects to be non-empty.
    expect(functions.length, 'no module-scope functions found').toBeGreaterThan(15);
    for (const n of ['canEditRoom', 'settleCupolaConflicts', 'isEditModeActive']) {
      expect(functions.some((f) => f.name === n), `${n} not sliced`).toBe(true);
    }

    const bad: string[] = [];
    for (const f of functions) {
      // One slice, one function: it closes at the first column-0 brace, so a
      // second column-0 declaration inside it means the first one never
      // closed and the slice ran on.
      if (/\n(?:export )?(?:async )?function /.test(f.body)) {
        bad.push(`${f.name} (line ${lineAt(f.start)}) swallowed a later declaration`);
      }
      if (!f.body.trimEnd().endsWith('}')) {
        bad.push(`${f.name} (line ${lineAt(f.start)}) has no closing brace at column 0`);
      }
      // Nothing at module scope may reach into the class, or a method's gate
      // and a free function's write would land in the same slice.
      if (f.start < classEnd && f.end > classAt) {
        bad.push(`${f.name} (line ${lineAt(f.start)}) overlaps the class body`);
      }
    }
    for (let i = 1; i < functions.length; i += 1) {
      if (functions[i].start < functions[i - 1].end) {
        bad.push(`${functions[i - 1].name} runs into ${functions[i].name}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);

    // Identity, not name. The first run of this test found the collision it
    // was written to worry about: `isEditModeActive` is a method AND the
    // module-scope function main.ts calls to reach it. Keyed by name those
    // are one node, and a gate on either would vouch for the other. Keyed by
    // declaration offset they are two.
    const ids = units.map(idOf);
    expect(new Set(ids).size, 'two units share an id, so one will stand in for the other')
      .toBe(ids.length);
    const shared = functions.filter((f) => members.some((m) => m.name === f.name));
    expect(shared.map((f) => f.name), 'the collision this model is built to survive')
      .toContain('isEditModeActive');

    // And the thing that keeps those two apart is one lookbehind, so test it
    // against the real call sites rather than trusting it. A free function's
    // pattern must match its bare call and neither dotted form.
    for (const f of shared) {
      const re = callPattern(f);
      expect(re.test(`${f.name}()`), `${f.name}: bare call not matched`).toBe(true);
      expect(re.test(`this.${f.name}()`), `${f.name}: this. call wrongly matched`).toBe(false);
      expect(re.test(`roomEdit.${f.name}()`), `${f.name}: obj. call wrongly matched`).toBe(false);

      // The other half, and the one a lookbehind does not solve: the
      // member's own declaration, `public isEditModeActive(…)`, is a bare
      // `isEditModeActive(` too. Read as a call it would make the member a
      // caller of the free function and hand over its gate, so a gated
      // method would silently cover an ungated module-scope writer of the
      // same name. `blankDecl` is what stops that; this is the assertion
      // that says so.
      for (const m of members.filter((x) => x.name === f.name)) {
        expect(re.test(m.callBody),
          `${f.name}: the member's declaration is being read as a call to the free function`)
          .toBe(false);
      }
    }
  });

  it('gates every method that writes, or that is reached only from gated ones', () => {
    const calls = (body: string, fn: string): boolean =>
      new RegExp(`\\b${fn}\\s*\\(`).test(body);
    // Escaped: the gates contain '.' and '()', which are regex syntax.
    const GATE_RE = GATES.map((g) => new RegExp(g.replace(/[.()]/g, '\\$&')));
    const WRITER_RE = WRITERS.map((w) => new RegExp(`\\b${w}\\s*\\(`));
    const firstAt = (body: string, res: readonly RegExp[]): number => {
      const hits = res.map((r) => body.search(r)).filter((i) => i >= 0);
      return hits.length > 0 ? Math.min(...hits) : -1;
    };

    // A gate counts only if it comes BEFORE the first write in the same
    // slice. Containment alone would accept a check made after the doc has
    // already been mutated, which is not a check; it would also accept one
    // in an unrelated branch, which this still cannot tell apart — see the
    // limits noted at the top of this file.
    const gated = new Set(units.filter((u) => {
      const gate = firstAt(u.body, GATE_RE);
      if (gate < 0) return false;
      const write = firstAt(u.body, WRITER_RE);
      return write < 0 || gate < write;
    }).map(idOf));

    // Who calls whom, by identity rather than by name — see `idOf`. A unit
    // with no in-file caller is an entry point: main.ts drives it, and for
    // the module-scope functions that is the only way in, so gating is the
    // only thing that can cover them.
    const pattern = new Map(units.map((u) => [idOf(u), callPattern(u)] as const));
    const callersOf = new Map<string, Set<string>>();
    for (const u of units) {
      const from = idOf(u);
      for (const callee of units) {
        const to = idOf(callee);
        if (to === from) continue;
        if (pattern.get(to)!.test(u.callBody)) {
          (callersOf.get(to) ?? callersOf.set(to, new Set()).get(to)!).add(from);
        }
      }
    }

    // Least fixpoint: gated, or every caller is itself covered. A cycle of
    // ungated methods never gets marked, which is the conservative answer.
    const covered = new Set(gated);
    for (let changed = true; changed; ) {
      changed = false;
      for (const u of units) {
        const id = idOf(u);
        if (covered.has(id)) continue;
        const cs = callersOf.get(id);
        if (cs && cs.size > 0 && [...cs].every((c) => covered.has(c))) {
          covered.add(id);
          changed = true;
        }
      }
    }

    const leaks = units
      .filter((u) => !covered.has(idOf(u)))
      .map((u) => ({ u, writers: WRITERS.filter((w) => calls(u.body, w)) }))
      .filter(({ writers }) => writers.length > 0)
      .map(({ u, writers }) => `${u.name}() at line ${lineAt(u.start)} calls ${
        writers.join(', ')} with no owner check on any path`);

    expect(leaks, leaks.join('\n')).toEqual([]);
  });

  it('counts the writes it is actually guarding, so the scan cannot pass on nothing', () => {
    // If a rename made every WRITERS entry miss, the test above would pass with
    // an empty leak list. Pin the floor instead.
    const found = WRITERS.filter((w) => new RegExp(`\\b${w}\\s*\\(`).test(stripComments(SRC)));
    expect(found.length, `writers not found in editMode.ts: ${
      WRITERS.filter((w) => !found.includes(w)).join(', ')}`).toBe(WRITERS.length);

    // And every one of those calls has to land inside a slice, or the scan
    // never looked at it — it would not appear as a leak, it would appear as
    // nothing. This fired for real once: #184 merged `settleCupolaConflicts`,
    // a module-scope writer, into a file whose model knew only class members.
    // The answer was to teach the model about module-scope functions, not to
    // wave the call through, so what is left over here is now a shorter list
    // — a write in bare module scope, or in a helper nested inside something
    // else, where neither a member slice nor a function slice can see it.
    const bare = stripComments(SRC);
    const homeless: string[] = [];
    for (const w of WRITERS) {
      for (const hit of bare.matchAll(new RegExp(`\\b${w}\\s*\\(`, 'g'))) {
        const at = hit.index ?? 0;
        if (!units.some((u) => u.start <= at && at < u.end)) {
          homeless.push(`line ${lineAt(at)}: ${w}() is outside every member and function slice`);
        }
      }
    }
    expect(homeless, homeless.join('\n')).toEqual([]);
  });

  it('pins what editMode imports from the doc modules, so a new writer is noticed', () => {
    // The WRITERS list above is only as good as someone remembering to extend
    // it. This makes forgetting fail: add an import from one of these modules
    // and this test asks you which side of the line the new name is on.
    const EXPECTED: Record<string, string[]> = {
      './doorLayoutDoc': ['defaultDoorLayoutRecords', 'deleteDoorLayout', 'doorDisplayName',
        'doorSetIsAuthoritative', 'readAllDoorLayout', 'seedDoorLayoutDefaults', 'writeDoorLayout'],
      './windowLayoutDoc': ['WINDOW_DEFAULT', 'deleteWindowLayout', 'readAllWindowLayout',
        'writeWindowLayout'],
      './wallpaperLayoutDoc': ['readAllWallpaper', 'writeWallpaper'],
      './airHockeyThemeDoc': ['readAirHockeyTheme', 'writeAirHockeyTheme'],
      './furnitureDoc': ['deleteFurnitureItem', 'writeFurnitureItem'],
      './roomInventory': ['activeRoomId', 'addToRoomInventory'],
      './floorPlanDoc': ['clearDoorSlide', 'doorLateralLimitForWall', 'readCupolaWall',
        'roomCupola', 'roomHalfExtents', 'roomPlaceBounds', 'writeCupolaWall'],
    };
    for (const [mod, names] of Object.entries(EXPECTED)) {
      // Value imports only — `import type { … }` can't be called.
      const m = SRC.match(new RegExp(`import\\s+\\{([^}]*)\\}\\s*from\\s*'${mod}'`));
      expect(m, `no value import from ${mod}`).not.toBeNull();
      const got = m![1].split(',').map((x) => x.trim()).filter(Boolean).sort();
      expect(got, `${mod}: is any new name here a room-doc writer? If so add it to WRITERS`)
        .toEqual(names);
    }
  });

  it('starts a session behind the same gate, so a write is never the first check', () => {
    expect(bodyOf('enter')).toContain('canEditRoom()');
  });

  it('ends the session on a refusal rather than refusing one write at a time', () => {
    // The other half of the fix. A refusal used to cancel the one write and
    // leave the player in a live session — grid up, X / ＋ DOOR / ＋ WINDOW /
    // 🖼 WALLPAPER still on screen and beginCarry still ungated — all of which
    // would refuse in turn. exit() is also what restores a carry or door drag
    // that was in flight, so the two properties are the same line.
    const body = bodyOf('mayWriteRoomDoc');
    expect(body).toContain('canEditRoom()');
    expect(body).toContain('this.exit()');
    expect(body).toContain('this.hideContextMenu()');
    // The reason must be hinted AFTER the teardown, or exit()'s own hints win.
    expect(body.indexOf('showHint(perm.reason)')).toBeGreaterThan(body.indexOf('this.exit()'));
  });

  it('re-asks before the 🔭 button writes, not once when the session opened', () => {
    // cycleCupola arrived with #184's merge writing the floor plan with no
    // check of its own. The 🔭 button is only rendered inside an edit
    // session, so the write was authorised by the check made when the
    // session opened — but the button then stays on screen, and a share
    // revoked while it is up would let every later click through. That is
    // the same defect class as the five writers this file was written for,
    // and the generic scan above catches it; this names it, so the failure
    // says which button rather than which method.
    const body = bodyOf('cycleCupola');
    expect(body, 'cycleCupola not found').not.toBe('');
    const gate = body.indexOf('this.mayWriteRoomDoc()');
    expect(gate, 'the 🔭 button writes the floor plan with no owner check')
      .toBeGreaterThanOrEqual(0);
    expect(gate, 'the owner check must come before the first write, not after')
      .toBeLessThan(body.search(/\bwriteCupolaWall\s*\(/));
  });

  it('gates the conflict settler, the one room-doc write outside the class', () => {
    // settleCupolaConflicts clears a cupola when two players' edits merged
    // into a floor plan that cannot hold both. It runs on every floor-plan
    // change and once on join, from main.ts — so it is an entry point, and
    // the only in-file caller it has is none. Gating is the only thing that
    // can cover it, and `canEditRoom()` rather than the class's helper,
    // because there is no session here to end.
    const f = functions.find((x) => x.name === 'settleCupolaConflicts');
    expect(f, 'settleCupolaConflicts not found').toBeDefined();
    const gate = f!.body.indexOf('canEditRoom()');
    const write = f!.body.search(/\bwriteCupolaWall\s*\(/);
    expect(write, 'settleCupolaConflicts no longer writes — is this test still earning its place?')
      .toBeGreaterThanOrEqual(0);
    expect(gate, 'settleCupolaConflicts writes the floor plan with no owner check')
      .toBeGreaterThanOrEqual(0);
    expect(gate, 'the owner check must come before the write, not after').toBeLessThan(write);
  });

  it('keeps the two cancel paths speaking the same word', () => {
    // cancelDoorDrag's doc calls itself the mirror of cancelCarry. Mirrors with
    // different signatures are how the next person passes the wrong one: the
    // boolean this replaced meant "announce" at four call sites and "also end
    // the auto-entered session" at a fifth.
    for (const fn of ['cancelCarry', 'cancelDoorDrag']) {
      expect(SRC, `${fn} should take the shared cause union`)
        .toContain(`private ${fn}(cause: 'user' | 'teardown'): void {`);
    }
    expect(SRC.match(/cancel(?:Carry|DoorDrag)\((?:true|false)\)/g) ?? []).toEqual([]);
  });
});
