/**
 * 🔒 editMode — every room-doc write goes through the owner gate (source scan)
 *
 * Five writers in editMode.ts were never re-authorised: writeDoorLayout twice
 * (add, drag-commit), writeWindowLayout twice (add, resize) and writeWallpaper.
 * Three others were, each with its own hand-written refusal — which is how the
 * other five came to be missed. The fix routed all eight through one helper,
 * and this is the test that keeps the ninth from slipping past: it fails if a
 * method that calls a room-doc writer is not itself gated and is not reached
 * only from methods that are.
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
 * noticed. And it resolves `this.foo()` by name alone, so it would conflate
 * two same-named members and cannot follow a call through a variable.
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

/** [start, end) slices of the source, named for whatever declared them. */
const cut = (text: string, offset: number, re: RegExp, name: (m: RegExpMatchArray) => string) => {
  const hits = [...text.matchAll(re)];
  return hits.map((h, i) => ({
    name: name(h),
    start: offset + (h.index ?? 0),
    end: offset + (i + 1 < hits.length ? (hits[i + 1].index ?? text.length) : text.length),
  }));
};

const members: { name: string; body: string; start: number; end: number }[] = [];
for (const m of cut(SRC, 0, MEMBER_RE, (h) => h[1] ?? h[2])) {
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
    members.push({ ...p, name, body: stripComments(SRC.slice(p.start, p.end)) });
  }
}

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
    const classAt = SRC.indexOf('\nclass RoomEditController {');
    expect(classAt, 'class RoomEditController not found').toBeGreaterThan(0);
    const classEnd = SRC.indexOf('\n}', classAt);
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
    const gated = new Set(members.filter((m) => {
      const gate = firstAt(m.body, GATE_RE);
      if (gate < 0) return false;
      const write = firstAt(m.body, WRITER_RE);
      return write < 0 || gate < write;
    }).map((m) => m.name));

    // Who calls whom, within the class. A method with no in-file caller is an
    // entry point (main.ts drives it), so it can only be covered by gating.
    const callersOf = new Map<string, Set<string>>();
    for (const m of members) {
      for (const other of new Set(members.map((x) => x.name))) {
        if (other === m.name) continue;
        if (calls(m.body, `this\\.${other}`)) {
          (callersOf.get(other) ?? callersOf.set(other, new Set()).get(other)!).add(m.name);
        }
      }
    }

    // Least fixpoint: gated, or every caller is itself covered. A cycle of
    // ungated methods never gets marked, which is the conservative answer.
    const covered = new Set(gated);
    for (let changed = true; changed; ) {
      changed = false;
      for (const m of members) {
        if (covered.has(m.name)) continue;
        const cs = callersOf.get(m.name);
        if (cs && cs.size > 0 && [...cs].every((c) => covered.has(c))) {
          covered.add(m.name);
          changed = true;
        }
      }
    }

    const leaks = members
      .map((m) => ({ name: m.name, writers: WRITERS.filter((w) => calls(m.body, w)) }))
      .filter((m) => m.writers.length > 0 && !covered.has(m.name))
      .map((m) => `${m.name}() calls ${m.writers.join(', ')} with no owner check on any path`);

    expect(leaks, leaks.join('\n')).toEqual([]);
  });

  it('counts the writes it is actually guarding, so the scan cannot pass on nothing', () => {
    // If a rename made every WRITERS entry miss, the test above would pass with
    // an empty leak list. Pin the floor instead.
    const found = WRITERS.filter((w) => new RegExp(`\\b${w}\\s*\\(`).test(stripComments(SRC)));
    expect(found.length, `writers not found in editMode.ts: ${
      WRITERS.filter((w) => !found.includes(w)).join(', ')}`).toBe(WRITERS.length);

    // And every one of those calls has to land inside a slice, or the scan
    // never looked at it. A write in module scope, in a nested helper
    // function, or past the end of the class is invisible to a member-based
    // model — it would not appear as a leak, it would appear as nothing.
    // There are none today; the point is to hear about the first one.
    const bare = stripComments(SRC);
    const homeless: string[] = [];
    for (const w of WRITERS) {
      for (const hit of bare.matchAll(new RegExp(`\\b${w}\\s*\\(`, 'g'))) {
        const at = hit.index ?? 0;
        if (!members.some((m) => m.start <= at && at < m.end)) {
          homeless.push(`line ${lineAt(at)}: ${w}() is outside every member slice`);
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
      './floorPlanDoc': ['clearDoorSlide', 'doorLateralLimitForWall', 'roomHalfExtents',
        'roomPlaceBounds'],
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
