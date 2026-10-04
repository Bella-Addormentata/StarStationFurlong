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

/** Comments name writers too (method docs especially) — strip them first. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * Every member of RoomEditController, sliced from its declaration to the next
 * one. Safe because every member in that class carries an explicit
 * accessibility modifier — asserted below, so the day one does not, this
 * breaks loudly instead of silently skipping a method.
 */
const MEMBER_RE = /^ {2}(?:public|private|protected) (?:static )?(?:readonly )?(?:async )?([A-Za-z_$][\w$]*)/gm;

const members: { name: string; body: string }[] = [];
{
  const hits = [...SRC.matchAll(MEMBER_RE)];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index ?? 0;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? SRC.length) : SRC.length;
    members.push({ name: hits[i][1], body: stripComments(SRC.slice(start, end)) });
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

  it('gates every method that writes, or that is reached only from gated ones', () => {
    const calls = (body: string, fn: string): boolean =>
      new RegExp(`\\b${fn}\\s*\\(`).test(body);

    const gated = new Set(
      members.filter((m) => GATES.some((g) => m.body.includes(g))).map((m) => m.name),
    );

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
