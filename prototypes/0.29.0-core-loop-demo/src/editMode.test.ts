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
 * it checks the gate comes FIRST, which is necessary and not sufficient.
 * "First" now means before the first EFFECT, counting a call to anything
 * that reaches a write as well as a write of its own, because a method that
 * names no writer used to skip the ordering test entirely and lend its gate
 * to whatever it had already called. Units that re-check at the moment they
 * act stop that walk, since a caller has nothing to answer for in front of
 * them — but ordering is still only offsets, and offsets stop describing
 * execution at the first `await`, which is why there is a canary for that
 * rather than a claim about it. It
 * knows only the writers in WRITERS below, so a write reached indirectly
 * through another module is invisible to it. Two tests narrow that and
 * neither closes it: the import-surface test fails when editMode imports a
 * new name from a doc module, and the World-surface test fails when it
 * reaches a new name through `this.world`. Between them they cover the two
 * doors a new writer has actually arrived through — `removeFurnitureVisuals`
 * came through the second, which is exactly why it is not an example of the
 * first. A write one further hop out, through a module whose own text names
 * no Yjs, is narrowed by a third: a relay may not hold a writer by name, so
 * a wrapper, a rename or a re-export of one is reported. What is left after
 * that is a relay reaching a write without naming it anywhere, and that is a
 * limit of the medium rather than an oversight — three cross-module analyses
 * were built and measured against this tree while closing the #198 audit, and
 * every one produced false positives and not one true positive, because a
 * read accessor and a write accessor share their helpers and no amount of
 * text tells `Map.set` from `Y.Map.set`. An unsound check here would be worse
 * than none: what people learn from a failure they cannot act on is how to
 * silence it. It keys the call graph on each declaration's
 * offset, so two units sharing a name stay apart — `isEditModeActive` is
 * both a method and a module-scope function here — but it still matches call
 * sites textually and so cannot follow a call made through a variable.
 *
 * ⚠️ And the scope, which is one file. Every unit, caller and gate below is
 * read out of editMode.ts, so "no room-doc write without an owner check"
 * means no such write FROM THIS FILE. The same writers are called from four
 * others — main.ts (claim-time defaults), devMenu.ts (dev spawn), docking.ts
 * (the door panel's slide), roomTemplates.ts (releaseDroppedDocks under a
 * template apply) — and each answers to its own path. docking.ts guards that
 * branch with `isRoomOwner()` (:2213), which is not a name in GATES, and
 * that is the point rather than a complaint: a sibling can be properly gated
 * in a vocabulary this scan does not speak, so a pass here is not a claim
 * about it in either direction.
 *
 * It is also worth saying plainly what the gate is NOT. Nothing authorises a
 * room-doc write today — roomOwner.ts says so outright — so a modified client
 * ignores every check counted here. This is UI correctness for honest clients.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The compiler this package already builds with, used here only as a PARSER:
// `createSourceFile` reads text and returns a tree. It does not load, resolve
// or execute editMode.ts, so the reason this whole file scans rather than
// imports — editMode.ts touches `window` and THREE at module scope — is
// untouched by it. One check below needs to know which braces in the file
// open a function body, and that is a question about the grammar with an
// exact answer; see 'refuses a write in a nested callback'.
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** The directory this test and editMode.ts share; the sibling modules too. */
const DIR = dirname(fileURLToPath(import.meta.url));
/** The file under scan. Held as a path, not a basename — see `elsewhere`. */
const SRC_PATH = join(DIR, 'editMode.ts');
const SRC = readFileSync(SRC_PATH, 'utf8');

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
  // The one entry that is NOT a shared-doc write, listed so the exception is
  // visible rather than inferred from the name: addToRoomInventory ends at
  // localStorage.setItem plus a window event (roomInventory.ts:83-96), so no
  // other client ever sees it. It stays because it is per-room persisted
  // state on the ✕ REMOVE path, which has to be gated for deleteFurnitureItem
  // anyway — requiring the gate here costs nothing and asserts the obvious.
  'addToRoomInventory',
  'clearDoorSlide', // floorPlanDoc — planMap.delete inside a transact
  'writeCupolaWall', // floorPlanDoc — planMap.set/delete inside a transact
  'clearRobotConfig', // robotDoc — setConfigIn inside a transact on the room doc
  // Not imported: reached through `this.world`, whose type arrives as
  // `import type { World }` and whose VALUE arrives as enter()'s argument.
  // The derived import check below therefore cannot see it, correctly — a
  // type import has nothing to call. It writes two docs one level down:
  // world.ts:3199 clearTable (games/gamesDoc.ts:125, transact + map.delete)
  // and world.ts:3182 closeTable (croupier.ts:167 -> casinoDoc
  // clearTableKeys, plus creditChips for unsettled stakes). 'the World
  // surface' test below is what keeps the next such name from arriving
  // unclassified.
  'removeFurnitureVisuals',
] as const;

/** Both forms of gate: the shared helper, and the raw predicate it wraps. */
const GATES = ['this.mayWriteRoomDoc()', 'canEditRoom()'];

/**
 * Every relative module specifier in a file, in any of the seven forms, as
 * capture 1. Used by the derived half of the import-surface test to decide
 * which modules it is obliged to read.
 *
 * Until the #198 audit this was `^import\s+\{…\}\s*from\s*'(\.…)'` — the
 * braced form alone, which is six other ways a module could arrive without
 * anything looking at it: a default import, a namespace import, the mixed
 * form, a bare side-effect import, a re-export and `import()`. editMode.ts
 * uses two of the seven today; the seventh is a one-line edit away, and
 * would have been silent. The shapes are pinned by fixtures below rather
 * than by the real file, which only contains the two.
 *
 * The middle branch walks a statement that may wrap across lines — the
 * braced imports in editMode.ts do — stopping at a `;` or at the next line
 * that begins a new `import`/`export`, so a missing quote cannot run the
 * match into the following statement.
 */
const SPECIFIER = new RegExp(
  '(?:^[ \\t]*(?:import|export)\\s+type\\s[^\'"]*'
  + '|^[ \\t]*(?:import|export)\\b(?:[^\'"\\n;]|\\n(?![ \\t]*(?:import|export)\\b))*?'
  + '|\\bimport\\s*\\(\\s*)'
  + '[\'"](\\.[^\'"]+)[\'"]',
  'gm',
);

/**
 * A specifier match that brings in no value. Excluded deliberately: a type
 * has nothing to call, so nothing editMode does can reach a write through
 * one. It is a real hole all the same, and the one `./world` falls into —
 * 'pins the World surface too' closes that from the other end rather than
 * pretending an import check can reach it.
 */
const TYPE_ONLY = /^[ \t]*(?:import|export)\s+type\s/;

/**
 * Comments name writers too (method docs especially) — strip them first.
 *
 * Blanked rather than deleted, so an offset into the stripped text is still
 * an offset into the original. Two things here depend on that: slice bounds
 * are measured on SRC and compared against matches found in stripped text,
 * and `lineAt` has to keep reporting the line a reader can go and look at.
 *
 * One left-to-right pass rather than two regexes, because the categories
 * nest and only reading order can say which opened first: `'http://x'` is a
 * string holding what looks like a comment, and `// don't` is a comment
 * holding what looks like a quote. Neither exists in editMode.ts today, and
 * the pass is here so that the first one to arrive cannot blank a span that
 * carries a gate.
 *
 * `strings` asks for string and template TEXT to be blanked as well, which
 * the gate scan needs and nothing else does — see `gateBody`. A template's
 * `${…}` holds real code and is left alone, so `{` and `}` stay balanced
 * either way and the listener brace-matcher can count on this output.
 *
 * Regex literals are lexed too, as of the #198 audit, and that is not
 * hypothetical tidiness: a regex is a literal whose TEXT was being read as
 * code, so `/\/\//` tripped the `//` branch and blanked to end of line in
 * BOTH modes — deleting whatever stood after it, a room-doc write included.
 * The unit then showed no write and was not reported as a leak. That is the
 * one failure mode this file must never have: a silent pass. editMode.ts has
 * no regex literal today, so the branch is unexercised by the real scan and
 * is pinned by fixtures below instead.
 */

/**
 * The words after which a `/` opens a pattern rather than dividing. Every
 * other identifier is a value, and a value is something you can divide.
 */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

const blankOut = (s: string, strings: boolean): string => {
  // split(''), not [...s]: code units, so an index here is an index in `s`
  // even where editMode.ts uses an astral character (the 🔭 button label).
  const out = s.split('');
  const wipe = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // Every throw below quotes a position, because these all mean "this scan
  // cannot read the file" — and a scan that cannot read the file has to say
  // so, not return a blanked span that looks like a clean answer.
  const die = (at: number, why: string): never => {
    throw new Error(`editMode.test blankOut: ${why} at line ${s.slice(0, at).split('\n').length
    } of the scanned span. The scan cannot read this file correctly; fix the lexer.`);
  };
  const resume: number[] = []; // brace depth each open template waits to see
  const heads: string[] = []; // the word before each open `(` — see `slash`
  let lit = -1; // start of the template text run being read, or -1 for code
  let depth = 0;
  let word = ''; // last identifier seen, so `(` knows what it is the head of
  // Whether a `/` here would open a regex, divide the value before it, or
  // cannot be told apart. `}` is the only ambiguous one that survives: it
  // ends a block (regex follows) or an object literal (division follows),
  // and telling those apart needs a parser. editMode.ts has no `}` followed
  // by a bare `/`, so this refuses rather than guesses.
  let slash: 'regex' | 'divide' | 'ambiguous' = 'regex';
  let i = 0;
  while (i < s.length) {
    if (lit >= 0) { // inside a template literal's text
      if (s[i] === '\\') { i += 2; } else if (s[i] === '`') {
        if (strings) wipe(lit, i + 1);
        lit = -1; resume.pop(); slash = 'divide'; i += 1; // a template is a value
      } else if (s.startsWith('${', i)) {
        if (strings) wipe(lit, i); // the substitution is code: keep it
        lit = -1; depth += 1; slash = 'regex'; i += 2; // and it opens an expression
      } else { i += 1; }
      continue;
    }
    const c = s[i];
    if (s.startsWith('//', i)) { // a comment decides nothing: `slash` carries over
      const nl = s.indexOf('\n', i);
      const stop = nl < 0 ? s.length : nl;
      wipe(i, stop); i = stop;
    } else if (s.startsWith('/*', i)) {
      const close = s.indexOf('*/', i + 2);
      // Not `s.length`: an unterminated block comment would blank the rest
      // of the unit — every gate and every write in it — and pass.
      if (close < 0) die(i, 'unterminated block comment');
      wipe(i, close + 2); i = close + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length || s[j] === '\n') die(i, 'unterminated string literal');
      if (strings) wipe(i, j + 1);
      slash = 'divide'; word = ''; i = j + 1;
    } else if (c === '`') {
      resume.push(depth); lit = i; i += 1;
    } else if (c === '/' && slash !== 'divide') {
      if (slash === 'ambiguous') {
        die(i, "cannot tell a regex literal from a division after '}'");
      }
      // `/…/flags`. Neither end can be found by searching: `\` escapes the
      // next character anywhere, and a `[…]` class may hold a bare `/`.
      let j = i + 1;
      let cls = false;
      for (; j < s.length; j += 1) {
        const r = s[j];
        if (r === '\\') { j += 1; continue; }
        if (r === '\n') die(i, 'unterminated regex literal');
        if (cls) { if (r === ']') cls = false; continue; }
        if (r === '[') cls = true;
        else if (r === '/') break;
      }
      if (j >= s.length) die(i, 'unterminated regex literal');
      j += 1;
      while (j < s.length && /[a-z]/.test(s[j])) j += 1; // flags
      // Blanked with the strings, and for the same reason: a gate named
      // inside a pattern is not a gate.
      if (strings) wipe(i, j);
      slash = 'divide'; word = ''; i = j;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[\w$]/.test(s[j])) j += 1;
      word = s.slice(i, j);
      slash = REGEX_AFTER.has(word) ? 'regex' : 'divide';
      i = j;
    } else if (c >= '0' && c <= '9') {
      slash = 'divide'; word = ''; i += 1; // a number is a value
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1; // decides nothing, and must not clear `word`: `if (x) /re/`
    } else if ((c === '+' || c === '-') && s[i + 1] === c) {
      // `++` and `--` are transparent to the question this state machine
      // is asking, unlike their single-character selves. Postfix `i++`
      // leaves a value behind, so `i++ / 2` divides; prefix `++i` stands
      // where an operand was already expected, so whatever decided before
      // it still decides. Carrying `slash` through unchanged is right in
      // both directions. Falling into the operator branch below is not:
      // `i++ / 2; … / …` would read as a regex literal and blank out
      // every gate and write between the two slashes.
      word = '';
      i += 2;
    } else {
      if (c === '(') { heads.push(word); slash = 'regex'; } else if (c === ')') {
        // `(a + b) / 2` divides; `if (a) /re/.test(b)` does not. The only
        // thing that separates them is the word the `(` belonged to.
        const head = heads.pop() ?? '';
        slash = head === 'if' || head === 'while' || head === 'for' ? 'regex' : 'divide';
      } else if (c === ']') { slash = 'divide'; } else if (c === '{') {
        depth += 1; slash = 'regex';
      } else if (c === '}') {
        depth -= 1; slash = 'ambiguous';
      } else { slash = 'regex'; } // an operator or a separator
      word = '';
      i += 1;
      // Back to the depth this template's `${` was opened from: its text
      // resumes at the character after the brace that closed the hole.
      if (c === '}' && resume.length > 0 && depth === resume[resume.length - 1]) lit = i;
    }
  }
  if (lit >= 0) die(lit, 'unterminated template literal');
  return out.join('');
};

const stripComments = (s: string): string => blankOut(s, false);

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
 * Where a listener is registered with its callback written inline. Each one
 * is a separate path from user input into the class, reached at an arbitrary
 * later time, so each is sliced out as its own entry point rather than
 * sharing the body it was written in. Sharing is not a technicality: a gate
 * in one handler would otherwise be credited to every other handler, and the
 * constructor's own `canEditRoom()` — which belongs to the right-click
 * handler — would vouch for all six of them.
 *
 * This used to apply to the constructor alone, on the reasoning that a
 * listener registered inside a method "already belongs to a method the scan
 * can see". That was the wrong half of the argument. The method is seen, but
 * what the method DOES when called is register a callback; what the callback
 * does happens later, on every click, under whatever permissions hold then.
 * A gate the method ran once at build time was being credited to a write
 * that fires indefinitely afterwards — the exact defect #198 was opened to
 * close, and thirteen of this file's nineteen registrations are in methods,
 * including the two buttons this branch is about (`wallpaperBtnEl` and the
 * cupola `btn`).
 *
 * Only inline callbacks are cut. `window.addEventListener('mousemove',
 * this.onMouseMove)` hands over a member the scan already models as its own
 * unit with no in-file caller, so it is already held to its own gate; there
 * is nothing to carve and carving it would lose the member's real body.
 *
 * Since the #198 audit the head also admits a `function` expression, a
 * parameter list with parentheses inside it (`(e = f())`, a default value)
 * and a return-type annotation. None of the three exists in editMode.ts
 * today; all three are callbacks the old pattern would have walked past,
 * leaving the body credited to the method that registers it — which is the
 * defect this carver was added to close, so the carver must not have it.
 */
const PARAMS = '\\((?:[^()]|\\([^()]*\\))*\\)'; // one level of nesting is enough
const RETTYPE = '(?:\\s*:[^=;{()]*)?'; // `(e: E): void => {`
const EVENT = "(?:'([\\w-]+)'|([A-Za-z_$][\\w$]*))";
/** An arrow's head, up to and including the `=>`. */
const ARROW_HEAD = `(?:async\\s+)?(?:${PARAMS}|[A-Za-z_$][\\w$]*)${RETTYPE}\\s*=>`;
/** Either function syntax's head, up to where a braced body would open. */
const FN_HEAD = `(?:${ARROW_HEAD}|(?:async\\s+)?function\\s*(?:[A-Za-z_$][\\w$]*)?`
  + `\\s*${PARAMS}${RETTYPE})`;
const LISTENER_RE = new RegExp(`\\.addEventListener\\(\\s*${EVENT}\\s*,\\s*${FN_HEAD}\\s*\\{`, 'g');

/**
 * The same registration, but stopping at the arrow — so a callback with a
 * CONCISE body (`() => writeWallpaper(x)`) matches this and not the pattern
 * above. There is no brace to match, so there is nothing to carve; the
 * canary below reports any that appear rather than letting one fold back
 * into the registering method and borrow its gate. editMode.ts has none.
 */
const INLINE_RE = new RegExp(`\\.addEventListener\\(\\s*${EVENT}\\s*,\\s*${ARROW_HEAD}`, 'g');

/**
 * A registration whose callback is only NAMED — `window.addEventListener(
 * 'mousemove', this.onMouseMove)`, three of them in editMode.ts. There is no
 * body here to carve, and none is needed: the thing named is declared
 * somewhere the scan already reads and answers for itself there. Anchored
 * and non-global, because it is asked about one offset at a time.
 */
const BY_REF_RE = new RegExp(
  `^\\.addEventListener\\(\\s*${EVENT}\\s*,\\s*`
  + '(?:this\\.)?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
  + '(?:\\.bind\\([^()]*\\))?\\s*[,)]',
);

/**
 * A handler assigned to a field and registered later by reference:
 * `this.ctxDismissPointer = (ev) => {…}` at editMode.ts:2038, handed to
 * addEventListener nine lines further down. This is repair (b)'s own defect
 * class wearing a different syntax — the body runs at an arbitrary later
 * time, under whatever permissions hold then — and neither pattern above
 * sees it: it is not a declaration, so MEMBER_RE walks past, and the
 * registration names a variable, so LISTENER_RE walks past too. Without
 * this the body stays inside `showContextMenu` and inherits its coverage.
 *
 * `this.` is load-bearing. `private onMouseMove = (e) => {…}` is the same
 * shape at member indentation, and MEMBER_RE already gives that one a unit
 * of its own; carving it again would cut the member out of itself.
 */
const FIELD_HANDLER_RE = new RegExp(
  `\\bthis\\.([A-Za-z_$][\\w$]*)\\s*=\\s*${ARROW_HEAD}\\s*\\{`,
  'g',
);

/**
 * The bracket that turns a name into a call, allowing the optional-call form
 * in front of it. `writeCupolaWall?.('x+')` calls writeCupolaWall and a plain
 * `\s*\(` does not match it — so every writer, gate, callee and deferral
 * pattern built from one would have read that line as calling nothing, which
 * is a room-doc write that needs no gate because the scan cannot see it.
 * editMode.ts has six `?.(` sites today (:1306, :1307, :1450, :1617, :2083,
 * :2105) and none of them is a writer, which is a fact about this afternoon
 * rather than a property of the file.
 *
 * Declared up here, above the deferral heads rather than beside the call
 * graph, because `setTimeout?.(…)` and `p.then?.(…)` defer exactly as their
 * plain forms do: a head that cannot see them leaves the callback body
 * standing in the method that scheduled it, under a gate that ran at
 * scheduling time. That is finding #1 arriving through a different door.
 */
const CALL = '\\s*(?:\\?\\.)?\\s*\\(';

/**
 * A member reached by name, in every shape that reaches the same method:
 * `.doThing`, `?.doThing`, `['doThing']`, `?.['doThing']`, and the same with
 * a double-quoted or template key.
 *
 * Computed access is the half that used to be missing, and it is the half an
 * escape hatch gets written in. The caller rule excuses four units on the
 * grounds that they are private and no sibling module names them, and
 * `private` is a compile-time word: `ed['removeSelectedDoor']('north')`
 * compiles, runs, and walked straight past a check spelled with a dot.
 *
 * A literal key only. `ed[name]()` cannot be resolved by reading text, and
 * pretending otherwise would be the guess this file exists to refuse — what
 * covers that case is the honest-client caveat at the top, not this pattern.
 */
const MEMBER = (n: string): string => `\\s*(?:(?:\\?\\.|\\.)\\s*${n}`
  + `|(?:\\?\\.)?\\s*\\[\\s*(?:'${n}'|"${n}"|\`${n}\`)\\s*\\])`;

/**
 * 🕐 The other way a body runs later, and the one editMode.ts does not use
 * — today. An `addEventListener` callback is only the shape that happened to
 * be here when this carver was written; a timer, a promise continuation and
 * a handler property defer in exactly the same way and were walked straight
 * past, their bodies left standing in the method that scheduled them, under
 * a gate that ran at scheduling time. The #198 audit put each of them in as
 * a mutant and every one PASSED, which is the only evidence that matters:
 * the scan would have reported clean on a file with a deferred, ungated
 * room-doc write in it.
 *
 * So they are carved like listeners rather than named in a blocklist. The
 * difference matters both ways round: a deferred callback that writes then
 * has to carry its own gate, and one that does not write — most of them,
 * `setTimeout(() => this.hideHint(), 2000)` — carves cleanly and is free.
 * A rule that merely refused the primitive would fail the harmless case and
 * teach people to work around it.
 *
 * `.then`/`.catch`/`.finally` are included as syntax, not as a claim that a
 * Promise is in play: a method named `then` on some other object reads the
 * same, and carving it is harmless where refusing it would not be.
 */
const TIMER = '(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask'
  + '|setImmediate|requestIdleCallback)';
/**
 * A handler PROPERTY, `el.onclick = …`. Matched from the dot, so it lines up
 * with the other heads, and loose about the name: `.only`, `.online` and
 * `.onlyChild` match too. That is deliberate — the alternative is a list of
 * DOM event names that goes stale — and it costs nothing, because a
 * non-function right-hand side is not a site at all (see DEFER_SITE_RE) and
 * an identifier one is absorbed by the by-reference rule.
 *
 * `(?<!\bthis)` keeps it off FIELD_HANDLER_RE's ground. `this.onMouseMove =
 * (e) => {…}` is one callback, and without this both heads would match it
 * at different offsets — two spans over one body, which the overlap check
 * downstream would then report as a fault in a file that has none.
 */
const HANDLER_PROP = '(?<!\\bthis)\\.(on[a-z][\\w$]*)\\s*=\\s*(?!=)';
const DEFER_HEAD = `(?:\\b(${TIMER})${CALL}\\s*|\\.(then|catch|finally)${CALL}\\s*|${HANDLER_PROP})`;
const DEFERRED_RE = new RegExp(`${DEFER_HEAD}${FN_HEAD}\\s*\\{`, 'g');

/** The same, stopping at the arrow — a concise body, which cannot be carved. */
const DEFERRED_INLINE_RE = new RegExp(`${DEFER_HEAD}${ARROW_HEAD}`, 'g');

/**
 * Every deferral site, in whatever shape — the exhaustiveness canary's
 * input, the way `.addEventListener(` is for listeners. A handler property
 * counts only when something function-shaped is assigned: `(`, an
 * identifier or `function`. `this.onlyChild = 3` is not a deferral and
 * should not have to be argued about.
 */
const DEFER_SITE_RE = new RegExp(
  `\\b${TIMER}${CALL}|\\.(?:then|catch|finally)${CALL}`
  + `|${HANDLER_PROP}(?=(?:async\\s+)?(?:\\(|function\\b|[A-Za-z_$]))`,
  'g',
);

/**
 * A deferral handed something already declared: `setTimeout(this.tick, 16)`,
 * `p.then(this.onDone)`, `el.onclick = this.onClick`. Nothing to carve, and
 * for a member nothing to carve it from — the thing named is a unit of its
 * own with no in-file caller, so it already answers for itself.
 *
 * ⚠️ The limit, shared with BY_REF_RE: a LOCAL arrow handed over by name
 * (`const h = () => {…}; setTimeout(h)`) is not a unit, so nothing answers
 * for it. Tracking that would mean tracking local bindings, which is a type
 * checker's job; what this file can honestly do is say so here.
 */
const DEFER_BY_REF_RE = new RegExp(
  `^(?:\\b${TIMER}${CALL}\\s*|\\.(?:then|catch|finally)${CALL}\\s*|${HANDLER_PROP})`
  + '(?:this\\.)?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
  + '(?:\\.bind\\([^()]*\\))?\\s*[,);]',
);

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
 * The file as the compiler reads it, parsed once.
 *
 * Every check that needs to know what a brace or a declaration IS asks
 * this tree rather than a pattern; the long note in 'refuses a write in a
 * nested callback' is why the patterns were given up on. It is parsed here
 * rather than inside the test that first needed it because the member
 * canary needs the same answer, and the canary's whole claim is that the
 * carver and the parser agree about where the members are — a claim two
 * separate parses could not make, since a later edit is free to change
 * the options of one and not the other.
 *
 * `setParentNodes` is the fourth argument and is what makes `getStart`
 * work. Nothing here loads, resolves or executes editMode.ts: this is the
 * text already read off disk, handed to a parser.
 */
const ast = ts.createSourceFile(SRC_PATH, SRC, ts.ScriptTarget.Latest, true);

/**
 * Every class member the parser can see, by where its declaration
 * starts — the same question MEMBER_RE answers by pattern, asked of
 * something that cannot be fooled by indentation or by a modifier it
 * has not been taught.
 *
 * `fn` is the one bit `unsorted`, down in 'refuses a write in a nested
 * callback', needs: is this member a function at all. A method,
 * constructor, getter or setter is. A property is
 * not — unless it holds one, `private onTick = () => { … }`, which the
 * regex this replaced read as a field and dropped on the floor.
 *
 * Deliberately not "has a body": an overload signature and an abstract
 * method are both functions with nothing to run, and answering YES
 * here is what sends them to `bodiless` to be named rather than sorted
 * quietly into the bucket for data.
 */
const parsed: {
  start: number; name: string; fn: boolean; what: string;
  // Which class declared it. A property holding a class expression has
  // that class's members inside its own span, and they are not siblings
  // of it — without this the check below would read `private x = class
  // { m() {} };` as a member that folded into another's slice and say so
  // about a file that is fine.
  cls: ts.ClassLikeDeclaration;
}[] = [];
/**
 * `(() => { … })` and `… as H`, `… satisfies H`, `…!`, `<H>…`: five
 * ways to write an initializer that is still a function, and the parser
 * reports the wrapper. Ask what is underneath before calling the member
 * data. All five were checked against the project's own `tsc` over a
 * function literal, because a wrapper the compiler rejects is not a
 * shape this needs to handle — which is what rules out
 * `ExpressionWithTypeArguments`, a call's type arguments rather than a
 * cast, and TS2635 over a literal.
 *
 * None of the five is in editMode.ts today. They are unwrapped anyway
 * because a miss here is quiet exactly where this file cares: a
 * wrapped function sorts as a field, never joins `fnUnits`, and so
 * never reaches `bodiless` to be named. An ungated write inside one is
 * still caught — the gate test works off the write, not off this flag
 * — so what is lost is the early warning, not the catch.
 *
 * Measured both ways, on a concise arrow behind an `as` cast holding an
 * ungated write: with the unwrap that arm fails twice and `bodiless`
 * names `probeW`; without it, once, and nothing says which member went
 * missing. Same species as the brace walk `collect` replaced, down in
 * 'refuses a write in a nested callback' — a guess about syntax — and
 * this one costs five predicates to stop guessing about.
 *
 * The return type is load-bearing, not decoration: without it a
 * self-referential arrow is TS7023, `implicitly has return type 'any'`,
 * and `tsc` exits 2.
 */
const unwrap = (e: ts.Expression): ts.Expression =>
  (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)
    || ts.isTypeAssertionExpression(e))
    ? unwrap(e.expression)
    : e;
/**
 * Members the carver is expected to open a unit on, which is not quite
 * every member the parser reports.
 *
 * A `;` alone at class level — a stray one after a method's closing brace,
 * or a line of its own — parses as a `SemicolonClassElement`. The grammar
 * gives it no name, no body, no initializer and no children at all, so it
 * holds nothing that could run and nothing can fold into it. The canary
 * below asks for one slice per member, and for one commit it asked for one
 * on these too, which reported a semicolon as a member whose work had been
 * credited to its neighbour's gate. Measured both ways: `  };` closing a
 * method and a lone `  ;` each failed two of sixteen with that message and
 * are silent with this predicate, while the pristine file is sixteen of
 * sixteen either way.
 *
 * Nothing else is excused, and an index signature is the near miss worth
 * naming. `  [k: string]: unknown;` holds no runtime code either, so its
 * report reads as the same unfairness — but it is the one member shape
 * whose declaration line cannot be told from a computed-name METHOD's by
 * text alone, and `  [KEY]() { … }` does hold code. MEMBER_RE matches
 * neither. So an index signature arriving in this class is proof that the
 * carver has a `[`-shaped gap, and the repair is to teach MEMBER_RE that
 * spelling, which covers the dangerous shape in the same edit. A semicolon
 * has no such sibling: nothing opening with `;` can carry a write.
 * Measured: `  [k: string]: unknown;` still fails two of sixteen, and so
 * does a computed-name method holding an ungated write, bare and with a
 * `private` in front of it alike.
 */
const carvable = (m: ts.ClassElement): boolean => !ts.isSemicolonClassElement(m);
const collectParsed = (n: ts.Node): void => {
  if (ts.isClassLike(n)) {
    for (const m of n.members) {
      // Kept out of `parsed` and not merely out of the canary, so the two
      // readers cannot drift: `unsorted` reports a second member inside a
      // unit's span, and a semicolon is not one.
      if (!carvable(m)) { continue; }
      const init = ts.isPropertyDeclaration(m) ? m.initializer : undefined;
      parsed.push({
        start: m.getStart(ast),
        name: ts.isConstructorDeclaration(m) ? 'constructor'
          : (m.name !== undefined && ts.isIdentifier(m.name) ? m.name.text : ''),
        fn: ts.isFunctionLike(m) || (init !== undefined && ts.isFunctionLike(unwrap(init))),
        what: ts.SyntaxKind[m.kind],
        cls: n,
      });
    }
  }
  ts.forEachChild(n, collectParsed);
};
collectParsed(ast);

/**
 * A named region of source the scan can look inside. `kind` is not
 * decoration: it decides how the unit is CALLED, and therefore how the call
 * graph below finds its callers — `this.foo(` for a member, bare `foo(` for a
 * module-scope function.
 *
 * Three views of the same span, each matched against by exactly one thing.
 * `body` is the text with comments blanked, and writes are found in it.
 * `callBody` additionally blanks the unit's own declaration, so the call
 * graph cannot read a declaration as a call. `gateBody` additionally blanks
 * string and template text, so an owner check cannot be counted because its
 * name appears inside a message. They are blanked, never cut, so an offset
 * is the same offset in all three and a gate's position stays comparable
 * with a write's.
 */
type Unit = {
  name: string; body: string; callBody: string; gateBody: string;
  start: number; end: number; kind: 'member' | 'function';
  // How a failure names this unit to a reader. A declared one is
  // `enter() at line 412`; a carved one already reads as a phrase with its
  // own line in it — "removeSelectedDoor's 'setTimeout' deferral at line
  // 2671" — and appending the declaration form to that produced
  // `…at line 2671() at line 2671`. Composed once here so a message cannot
  // pick the wrong shape, and `name` stays the bare identifier the
  // cross-module and privacy checks match on.
  label: string;
  // Carved out of the member that registers it, rather than declared. Kept
  // as a flag rather than sniffed back out of `name`, because the checks
  // below that apply only to carved spans are the ones that catch a carver
  // which has stopped working — and a name test would quietly match nothing.
  carved: boolean;
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

/**
 * The inline listener callbacks inside one member, as [start, end) spans
 * biased by `offset` — plus any registration this cannot carve: a concise
 * body, which has no brace to match, and any shape it does not recognise
 * at all.
 *
 * Takes the text rather than the member, so the carver can be handed a
 * fixture and asked what it makes of it. 'carves a callback out of the
 * method that registers it' below does exactly that: the real file only
 * contains the shapes someone already thought of, so passing on the real
 * file says nothing about the shapes that go wrong.
 *
 * Brace-matched rather than cut to the next registration, because a method
 * is not a list of handlers the way the constructor nearly is: there is real
 * code before and after each one, and it belongs to the method. Counting is
 * done on string- and comment-blanked text so that a brace inside a message
 * — `showHint(\`… {…}\`)` — is not read as structure.
 */
const carveListeners = (text: string, offset: number) => {
  // Two views, offset-identical to `text` and to each other, each used for
  // the one thing it can answer. Registrations are FOUND in `seen`, which
  // keeps string text, because the event name IS a string literal and
  // `code` has already blanked it away — matching there finds nothing at
  // all, which is the quiet kind of failure this carver must not have.
  // Braces are COUNTED in `code`, where a brace inside a message is gone.
  // Finding them in the raw text instead, which is what this did before the
  // #198 audit, would carve a registration written inside a comment.
  const seen = stripComments(text);
  const code = blankOut(text, true);
  // Each head captures its own name in whichever group its alternative
  // owns — the event for a listener, the field for an assigned handler, the
  // primitive for a deferral — so take the first one that fired rather than
  // numbering them, which would have to be renumbered on every new shape.
  const nameOf = (h: RegExpExecArray): string => h.slice(1).find((g) => g !== undefined) ?? '?';
  // `code[at] === seen[at]` asks whether this position is real code: a head
  // found inside a string is blanked in `code` and not in `seen`, so the two
  // disagree exactly there. Comments are blanked in both, and no head can
  // start on a space, so a match can never have begun in one.
  const isCode = (at: number): boolean => code[at] === seen[at];
  const spans: { event: string; start: number; end: number; closed: boolean; how: string }[] = [];
  const carve = (re: RegExp, how: string): void => {
    for (const h of seen.matchAll(re)) {
      const at = h.index ?? 0;
      // The pattern ends on the `{` that opens the callback, so start there
      // — but only if it is still a brace once string text is blanked out.
      // A registration written inside a string is not a registration, and
      // brace-matching from a character the compiler reads as message text
      // would close on some unrelated brace further down the file.
      const open = at + h[0].length - 1;
      if (code[open] !== '{') continue;
      let j = open;
      let closed = false;
      for (let depth = 0; j < code.length; j += 1) {
        if (code[j] === '{') depth += 1;
        else if (code[j] === '}' && (depth -= 1) === 0) { j += 1; closed = true; break; }
      }
      // `closed` is carried rather than thrown on, so the canary below can
      // name every bad span at once. A matcher that ran off the end used to
      // stop at the member's end and still look like a clean carve.
      spans.push({
        event: nameOf(h), start: offset + at, end: offset + j, closed, how,
      });
    }
  };
  carve(LISTENER_RE, 'listener');
  // Assigned handlers are named for the field, so a failure says which one.
  carve(FIELD_HANDLER_RE, 'handler');
  // Timers, promise continuations and handler properties — the same defect
  // class as a listener, and none of them present in editMode.ts today.
  carve(DEFERRED_RE, 'deferral');
  spans.sort((a, b) => a.start - b.start);

  // A registration whose callback is inline but has no brace to match: a
  // concise-body arrow. Nothing can be carved, so the body would stay in
  // the registering method and borrow its gate — the defect this carver
  // exists to close. Reported by the caller, never absorbed.
  const concise: { event: string; at: number }[] = [];
  for (const re of [INLINE_RE, DEFERRED_INLINE_RE]) {
    for (const h of seen.matchAll(re)) {
      const at = h.index ?? 0;
      // The head, for the same reason the brace is checked above.
      if (!isCode(at)) continue;
      if (!spans.some((l) => l.start === offset + at)
        && !concise.some((c) => c.at === offset + at)) {
        concise.push({ event: nameOf(h), at: offset + at });
      }
    }
  }

  // Exhaustiveness, and the only check here that does not depend on having
  // guessed the callback syntaxes right. Each branch above knows a shape;
  // this one knows none, and asks instead that every registration in the
  // member be claimed by one of them. A callback written in a shape nobody
  // listed — which is what actually went wrong here, twice, and both times
  // without a word — is otherwise absorbed into the registering method and
  // handed a gate that ran once, at registration time.
  const unknown: number[] = [];
  for (const [re, byRef] of [
    [/\.addEventListener\(/g, BY_REF_RE], [DEFER_SITE_RE, DEFER_BY_REF_RE],
  ] as const) {
    for (const h of code.matchAll(re)) {
      const at = h.index ?? 0;
      if (spans.some((l) => l.start === offset + at)) continue;
      if (concise.some((c) => c.at === offset + at)) continue;
      if (byRef.test(seen.slice(at))) continue;
      if (!unknown.includes(offset + at)) unknown.push(offset + at);
    }
  }
  unknown.sort((a, b) => a - b);
  return { spans, concise, unknown };
};

/** Blank a span of `text` in place, keeping its length and its newlines. */
const blankSpan = (text: string, from: number, to: number): string => text.slice(0, from)
  + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to);

/**
 * Everything the carver could not account for, asserted empty by the canary
 * below. Collected here rather than thrown, so one run names every fault
 * instead of the first — and collected at all because each of these used to
 * be silent: a span that ran off the end still looked carved, and a callback
 * the pattern walked past still looked like it had no callback to carve.
 */
const carveFaults: string[] = [];

const members: Unit[] = [];
for (const m of cut(SRC.slice(classAt, classEnd), classAt, MEMBER_RE, (h) => h[1] ?? h[2])) {
  // Each member is replaced by itself-minus-its-handlers plus one unit per
  // handler, named for the member, the event and the line, so a failure says
  // which one. The member keeps what it does when CALLED; blanking the
  // callbacks out of it is the whole point, since what they do happens later
  // and must answer for itself.
  const { spans: listeners, concise, unknown } = carveListeners(SRC.slice(m.start, m.end), m.start);
  let own = SRC.slice(m.start, m.end);
  for (const l of listeners) {
    if (!l.closed) {
      carveFaults.push(`${m.name}: the '${l.event}' ${l.how} at line ${lineAt(l.start)
      } never closes — the brace matcher ran to the end of the member`);
    }
    own = blankSpan(own, l.start - m.start, l.end - m.start);
  }
  // Sorted by start, so a pair that touches is a pair that overlaps. Two
  // overlapping spans would be blanked out of each other and the second
  // would carry a hole; `blankSpan` cannot report that for itself.
  for (let k = 1; k < listeners.length; k += 1) {
    if (listeners[k].start < listeners[k - 1].end) {
      carveFaults.push(`${m.name}: the ${listeners[k - 1].how} at line ${
        lineAt(listeners[k - 1].start)} overlaps the ${listeners[k].how} at line ${
        lineAt(listeners[k].start)}`);
    }
  }
  // Concise-body arrows: nothing to brace-match, so nothing to carve, so
  // the body is still standing in this method holding this method's gate.
  for (const c of concise) {
    carveFaults.push(`${m.name}: the '${c.event}' callback at line ${lineAt(c.at)
    } has a concise body, so it cannot be carved and is borrowing this method's gate`);
  }
  for (const at of unknown) {
    carveFaults.push(`${m.name}: the deferral at line ${lineAt(at)
    } is in a callback shape this file does not know, so its body is still standing `
    + 'in this method holding a gate that ran when the body was scheduled');
  }

  const parts = [
    { name: m.name, decl: m.raw, start: m.start, end: m.end, text: own, carved: false },
    // A listener slice opens at its addEventListener line — code, not a
    // declaration, and often carrying a real call — so nothing is blanked.
    ...listeners.map((l) => ({
      name: `${m.name}'s '${l.event}' ${l.how} at line ${lineAt(l.start)}`,
      decl: '', start: l.start, end: l.end, text: SRC.slice(l.start, l.end), carved: true,
    })),
  ];
  for (const p of parts) {
    const body = stripComments(p.text);
    members.push({
      name: p.name, start: p.start, end: p.end, kind: 'member', carved: p.carved,
      label: p.carved ? p.name : `${p.name}() at line ${lineAt(p.start)}`,
      body,
      callBody: blankDecl(body, p.decl),
      // Declaration-blanked as well, or a unit is gated by its own name:
      // `canEditRoom`'s slice opens with the word `canEditRoom(`, which the
      // gate pattern matches at offset 16. Harmless for that one — it
      // writes nothing — but any later module-scope function sharing a gate
      // name would have been auto-gated by having been declared.
      gateBody: blankDecl(blankOut(body, true), p.decl),
    });
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
    name: h[1], start, end, kind: 'function' as const, body, carved: false,
    label: `${h[1]}() at line ${lineAt(start)}`,
    callBody: blankDecl(body, h[0]),
    // Declaration-blanked for the same reason as a member's — and this is
    // the half where it bites, since `canEditRoom` is itself one of these.
    gateBody: blankDecl(blankOut(body, true), h[0]),
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
 * How a unit is reached from inside this file: `this.foo(` — or
 * `this['foo'](`, or either with `?.` — for a member, a bare `foo(` for a
 * module-scope function. The lookbehind carries the whole
 * distinction — without it `roomEdit.isEditModeActive()` and
 * `this.isEditModeActive()` would both read as calls to the free function.
 */
const callPattern = (u: Unit): RegExp => (u.kind === 'member'
  ? new RegExp(`\\bthis${MEMBER(u.name)}${CALL}`)
  : new RegExp(`(?<![.\\w$])${u.name}${CALL}`));

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

    // Both of those are text searches, and the carver cuts between them, so
    // everything below is taken over whatever they happened to find. Ask the
    // parser for the same two numbers. The `+ 1` and `+ 2` are part of the
    // claim rather than slack: `classAt` is the index OF the newline before
    // `class`, and `classEnd` the index of the `\n}` that closes it, so the
    // span the text found is `[classAt + 1, classEnd + 2)` and the two must
    // match exactly. A second `class RoomEditController` — a declaration
    // merge, a bad rebase — would make `classAt` open the first and
    // `classEnd` close it, leaving every member of the second outside every
    // slice. A room-doc write out there is not silent: `homeless`, in
    // 'refuses a write in a nested callback', scans the whole file and
    // reports a write that lands inside no unit at all. What would go
    // unsaid is everything else about those members — their gates, their
    // callers, whether the call graph can reach them — so the duplicate is
    // named here as a duplicate, by count rather than `.find`, instead of
    // arriving later as a write with no home.
    const classes = ast.statements.filter((n): n is ts.ClassDeclaration =>
      ts.isClassDeclaration(n) && n.name?.text === 'RoomEditController');
    expect(classes.length, 'the parser does not see exactly one top-level '
      + 'class RoomEditController').toBe(1);
    const cls = classes[0];
    expect(classAt + 1, 'the class the text found and the class the parser '
      + 'found do not start in the same place').toBe(cls.getStart(ast));
    expect(classEnd + 2, 'the class the text found and the class the parser '
      + 'found do not end in the same place').toBe(cls.end);

    const starts = new Set(members.map((m) => m.start));

    // Now the claim itself, and it is a claim about two machines agreeing:
    // the carver's units and the parser's members are the same list. Said
    // as a pattern it cannot be — MEMBER_RE has to be taught every modifier
    // and every indentation, and three ordinary shapes defeated it before
    // this was written. A `*gen()` generator, a `123()` numeric name and an
    // ordinary `private` method indented four spaces instead of two were
    // each invisible to it, and an ungated room-doc write inside any of the
    // three passed sixteen of sixteen in silence when the member declared
    // above it happened to be gated. Measured, all three, both ways: red
    // behind an ungated neighbour, green behind a gated one. Which is the
    // worst kind of pass this file can produce, because whether the write
    // is caught depends on who its neighbour is.
    //
    // A member is identified by the line its declaration opens on, not by
    // the declaration's own offset: a unit starts at column 0 of that line
    // and the parser's `getStart` points at the first token on it.
    const declLine = (at: number): number => SRC.lastIndexOf('\n', at - 1) + 1;
    const declared = cls.members.filter(carvable);
    const decls = new Set(declared.map((m) => declLine(m.getStart(ast))));
    // Two members on one line would leave both sets agreeing while one of
    // them still has no slice of its own, so the sizes are asserted before
    // the sets are.
    expect(decls.size, 'two class members share a declaration line, so at '
      + 'most one of them can be the start of a slice').toBe(declared.length);
    const unopened = declared
      .map((m) => declLine(m.getStart(ast)))
      .filter((at) => !starts.has(at))
      .map((at) => `line ${lineAt(at)}: ${SRC.slice(at, SRC.indexOf('\n', at)).trim()}`);
    expect(unopened, `MEMBER_RE opened no unit on these, so each one folded \
into the slice of the member above it and is credited to that member's gate:
${unopened.join('\n')}`).toEqual([]);
    // What that list enforces is stricter than it looks, and saying so is
    // part of the test: every member of this class has to be spelled one of
    // the ways MEMBER_RE accepts — two spaces of indent, a `public`,
    // `private` or `protected` in front, or `constructor`, and an
    // identifier for a name. A `#private` field, a `[computed]` or
    // `'string'` name, a `@decorator` on the line above, a bare
    // `name() {}`, a `static` with no visibility word, a generator
    // `*gen()`, a numeric `123()`, a tab instead of spaces: each is legal
    // TypeScript and each fails this test. That is deliberate, and it is a
    // style rule this file imposes on editMode.ts rather than a claim that
    // the spelling is wrong.
    //
    // The repair when one arrives is to teach MEMBER_RE the spelling and
    // check what it captures as the NAME — never to exempt the shape here,
    // because an exemption is silent and the fold it hides is not. The
    // name half is the part that goes wrong: `public get size(): number`
    // matches today and MEMBER_RE captures `get`, and until the parser was
    // asked nothing in this file would have said so. `unsorted`, down in
    // 'refuses a write in a nested callback', is what asks.
    //
    // A second arm used to stand here, re-scanning the raw class text for
    // `^ {2}[A-Za-z_$#'"@[]` and reporting any such line the carver did not
    // open a unit on. It was kept for one commit after the parser arm
    // landed, on the theory that it caught spellings the parser might not
    // report. It did not: every line it caught, the parser arm caught too,
    // and what it caught ALONE was prose indented two spaces inside a
    // template literal and inside a block comment. It matched text, so it
    // could not tell a declaration from the inside of a string, and both
    // of those are false reports about a file that is fine.
    //
    // And the other direction, which is what makes the first list mean
    // something: a unit opened where the parser declares no member is a
    // real member cut in half, and the half that keeps the gate is not
    // necessarily the half that holds the write.
    //
    // Nothing can reach that list today, and the reason is structural
    // rather than lucky, so it is worth writing down. A line that reads as
    // a declaration without being one has to sit inside a multi-line
    // construct: a template literal, a block comment, and a quoted string
    // continued with a backslash are the only three ways to begin a line
    // with `  private` and have the compiler not read it as code. A unit
    // cut at such a line is a span that opens inside that construct and
    // never closes it — which is the one thing `blankOut` refuses outright.
    // Measured, all three: `unterminated template literal`, `unterminated
    // block comment`, `unterminated string literal`, each thrown before a
    // single test runs, so the suite reports no tests at all rather than a
    // tidy pass. The fourth way in is a decorated member, where `getStart`
    // points at the `@` and MEMBER_RE at the `private` a line below, and
    // that one is reported by `unopened` above — asserted first, so the
    // test stops there and this list is never built. Measured: a decorated
    // method fails two of sixteen and the message names the method.
    //
    // The list stays, and so does the branch inside it, because an unread
    // message still has to be true. `the parser declares no class member on
    // that line` would be a lie about a decorated member, whose declaration
    // `unopened` has just named one line up; so when a member's span does
    // cover the line, the message says that instead.
    const phantom = members.filter((m) => !m.carved && !decls.has(m.start))
      .map((m) => {
        const over = declared.find((d) => d.getStart(ast) <= m.start && m.start < d.end);
        return over === undefined
          ? `${m.label}: the parser declares no class member on that line`
          : `${m.label}: the parser reads that line as the middle of a member `
            + `declared at line ${lineAt(declLine(over.getStart(ast)))}, so this `
            + `unit holds the back half of one member and the gate is in the front`;
      });
    expect(phantom, phantom.join('\n')).toEqual([]);

    // Said the other way round, without depending on a member's name: no
    // slice may contain a second member's declaration. This follows from the
    // list above being empty, and is asserted separately because it is the
    // property that actually matters and the cheaper one to read.
    const swallowed = members
      .filter((m) => /\n {2}(?:public|private|protected|constructor)\b/.test(m.body))
      .map((m) => `${m.name} (line ${lineAt(m.start)}) contains another member's declaration`);
    expect(swallowed, swallowed.join('\n')).toEqual([]);

    // And the handlers really were broken out — from methods as well as
    // from the constructor, which is the half this scan used to skip. The
    // counts are floors, not pins: what is asserted is that the split
    // happened on both sides, since a regex that quietly stopped matching
    // would fold every callback back into the body that registers it and
    // hand each one a gate that ran once, at build time.
    const handlers = members.filter((m) => m.carved);
    expect(handlers.filter((m) => m.name.startsWith("constructor's")).length,
      'the constructor was not split into its listeners').toBeGreaterThan(5);
    expect(handlers.filter((m) => !m.name.startsWith("constructor's")).length,
      'no method-registered listener was carved out, so each is still '
      + "credited to the gate of whatever method registered it").toBeGreaterThan(5);
    // The two buttons #198 is about, named rather than counted: both are
    // registered inside a method, and both reach a room-doc write.
    for (const n of ["showCupolaButton's 'click'", "showWallpaperButton's 'click'"]) {
      expect(handlers.some((m) => m.name.startsWith(n)), `${n} listener not carved out`)
        .toBe(true);
    }
    // The assigned-then-registered pair the #198 audit found uncarved: both
    // are written inside showContextMenu and handed to addEventListener by
    // name nine lines later, so neither pattern used to see them and both
    // bodies ran on whatever permissions held at dismiss time while holding
    // the gate showContextMenu passed when it opened.
    for (const n of ['ctxDismissPointer', 'ctxDismissKey']) {
      expect(handlers.some((m) => m.name.includes(`'${n}' handler`)),
        `${n}'s assigned body is still inside the method that assigns it`).toBe(true);
    }

    // Everything the carver could not account for. Each of these was silent
    // before #198's audit: a brace matcher that ran off the end stopped at
    // the member's end and looked like a clean carve, and a callback shape
    // the pattern did not know simply was not carved.
    expect(carveFaults, carveFaults.join('\n')).toEqual([]);

    // The carver only ever looks inside members, so a deferral written at
    // module scope is one it cannot reach — and `carveFaults` would stay
    // empty while saying nothing about it. All nineteen listeners are in the
    // class today and there are no other deferrals at all; this is what
    // notices the first one written outside.
    const stray = [/\.addEventListener\(/g, DEFER_SITE_RE]
      .flatMap((re) => [...blankOut(SRC, true).matchAll(re)].map((h) => h.index ?? 0))
      .filter((at) => at < classAt || at > classEnd)
      .sort((a, b) => a - b)
      .map((at) => `line ${lineAt(at)}: defers outside the class, so never carved`);
    expect(stray, stray.join('\n')).toEqual([]);

    // Each carved span must be a whole callback inside the member that
    // registered it. A brace-matcher that ran off the end would swallow the
    // rest of the class — and swallow it SILENTLY, since the extra text
    // would arrive carrying gates.
    const ill: string[] = [];
    for (const h of handlers) {
      const text = blankOut(SRC.slice(h.start, h.end), true);
      let depth = 0;
      for (const ch of text) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth !== 0) ill.push(`${h.name}: braces unbalanced by ${depth}`);
      if (!text.trimEnd().endsWith('}')) ill.push(`${h.name}: does not end on its closing brace`);
      // Containment used to be asserted against the member list, where it
      // could never fail: the carve loop is bounded by the member's own
      // text, so `end <= owner.end` holds by construction and the check
      // passed on spans that were demonstrably wrong. What CAN fail is the
      // span against the class — and against the carver's own record of
      // having found a closing brace, which is the `carveFaults` list above.
      if (h.start < classAt || h.end > classEnd + 2) {
        ill.push(`${h.name}: runs outside the class body`);
      }
      // A span of one line is a match on something that is not a callback.
      if (h.end - h.start < 4) ill.push(`${h.name}: carved an empty span`);
    }
    expect(ill, ill.join('\n')).toEqual([]);
  });

  it('carves a callback out of the method that registers it, or says it could not', () => {
    // The scan above passes on editMode.ts, which only ever contains the
    // shapes someone has already thought about. That is not evidence the
    // carver works — it is evidence the file is tidy. So hand the carver
    // each shape directly and check what it does with it, including the
    // shapes editMode.ts does not have, because those are the ones that
    // arrive later and quietly take a gate with them.
    const one = (src: string) => carveListeners(src, 0);

    // Carried: a body exists, so it becomes a unit of its own.
    for (const src of [
      "el.addEventListener('click', (e) => { a(); });",
      "el.addEventListener('click', function (e) { a(); });",
      "el.addEventListener('click', async (e: Ev): Promise<void> => { a(); });",
      "el.addEventListener('click', (e = f()) => { a(); }, true);",
      "el.addEventListener(NAME, (e) => { a(); });",
    ]) {
      const got = one(src);
      expect(got.spans.length, `not carved: ${src}`).toBe(1);
      expect(got.spans[0].closed, `never closed: ${src}`).toBe(true);
      expect(got.spans[0].how).toBe('listener');
      expect(src.slice(got.spans[0].start, got.spans[0].end).endsWith('}'),
        `span does not end on its brace: ${src}`).toBe(true);
      expect(got.concise.concat(got.unknown as never[])).toEqual([]);
    }

    // The assigned-handler shape, which is a registration nowhere near the
    // assignment — `how` says which pattern found it so a failure reads.
    const field = one('this.ctxDismissKey = (ev) => { a(); };');
    expect(field.spans.map((s) => [s.event, s.how, s.closed]))
      .toEqual([['ctxDismissKey', 'handler', true]]);

    // 🕐 The deferrals editMode.ts does not contain. Each of these was a
    // mutant in the #198 audit and each one PASSED: the body stayed inside
    // the scheduling method, the room-doc write inside it counted as
    // covered by whatever gate that method held, and the scan said clean.
    // A listener is not a special case of anything — it was just the shape
    // that happened to be in the file when the carver was written.
    for (const [src, event] of [
      ['setTimeout(() => { writeWallpaper(s, v); }, 0);', 'setTimeout'],
      ['setInterval(() => { a(); }, 16);', 'setInterval'],
      ['requestAnimationFrame((t: number) => { a(); });', 'requestAnimationFrame'],
      ['queueMicrotask(function () { a(); });', 'queueMicrotask'],
      ['p.then(async (v) => { a(); });', 'then'],
      ['p.catch((e) => { a(); });', 'catch'],
      ['el.onclick = (e) => { a(); };', 'onclick'],
    ] as const) {
      const got = one(src);
      expect(got.spans.map((s) => [s.event, s.how, s.closed]), `not carved: ${src}`)
        .toEqual([[event, 'deferral', true]]);
      expect(got.concise.concat(got.unknown as never[]), src).toEqual([]);
    }

    // Named, not written: nothing to carve, and nothing wrong either. The
    // thing named is declared somewhere this scan already reads.
    for (const src of [
      "el.addEventListener('click', this.onMouseMove);",
      "el.addEventListener('click', this.ctxDismissKey, true);",
      "el.addEventListener('click', onClick.bind(this));",
      'setTimeout(this.tick, 16);',
      'setTimeout(onTick.bind(this), 1);',
      'p.then(this.onDone);',
      'el.onclick = this.onClick;',
      // Not a deferral at all: nothing function-shaped is assigned, so the
      // loose `on…` name costs nobody an argument.
      'node.onlyChild = 3;',
      // FIELD_HANDLER_RE's ground, and it carves this one as a 'handler' —
      // asserted above. What matters here is that the new head does NOT
      // also match it, which would be two spans over one body.
      'this.onMouseMove = other;',
    ]) {
      expect(one(src), src).toEqual({ spans: [], concise: [], unknown: [] });
    }

    // And the one shape that must stay with FIELD_HANDLER_RE rather than
    // being claimed twice: one span, found by one pattern, named for the
    // field rather than for the `on…` property.
    expect(one('this.onMouseMove = (e) => { a(); };').spans.map((s) => [s.event, s.how]))
      .toEqual([['onMouseMove', 'handler']]);

    // Cannot be carved, so must be reported. A concise body has no brace to
    // match; a callback that is the RESULT of a call has no body here at
    // all. Either one left unreported stays inside the registering method
    // and runs forever on the gate that method passed once.
    expect(one("el.addEventListener('click', () => a());").concise)
      .toEqual([{ event: 'click', at: 2 }]);
    expect(one("el.addEventListener('click', (e) => a(e), true);").concise)
      .toEqual([{ event: 'click', at: 2 }]);
    expect(one("el.addEventListener('click', makeHandler(x));").unknown).toEqual([2]);
    expect(one("el.addEventListener('click', handlers['click']);").unknown).toEqual([2]);
    // The same two failures for a deferral, because the same two shapes
    // defeat it the same way.
    expect(one('setTimeout(() => writeWallpaper(s, v), 0);').concise)
      .toEqual([{ event: 'setTimeout', at: 0 }]);
    expect(one('el.onclick = () => a();').concise).toEqual([{ event: 'onclick', at: 2 }]);
    expect(one('setTimeout(makeTick(), 0);').unknown).toEqual([0]);
    expect(one("p.then(handlers['done']);").unknown).toEqual([1]);

    // Not code: a registration written inside a string or a comment is not
    // a registration, and brace-matching from one would close on some
    // unrelated brace much further down.
    for (const src of [
      "warn('el.addEventListener(\\'click\\', (e) => { a(); });');",
      "// el.addEventListener('click', (e) => { a(); });\nb();",
    ]) {
      expect(one(src), src).toEqual({ spans: [], concise: [], unknown: [] });
    }

    // A body that never closes is reported, not silently cut at the end of
    // whatever text the carver was handed. This is the one that used to
    // look like a clean carve.
    const torn = one("el.addEventListener('click', (e) => { a();");
    expect(torn.spans.map((s) => s.closed)).toEqual([false]);

    // A span opens at the `.` of the registration — code, and often a real
    // call — and is returned biased by `offset`, because the caller holds a
    // slice of SRC and every later check compares positions in SRC.
    expect(one("  el.addEventListener('click', (e) => { a(); });").spans[0].start).toBe(4);
    expect(carveListeners("el.addEventListener('c', (e) => { a(); });", 1000).spans[0].start)
      .toBe(1002);
  });

  it('reads strings as strings, so neither a gate nor a brace can hide in one', () => {
    // `blankOut` is the one piece of this file that is a parser rather than a
    // regex, and both halves of the scan now rest on it: gates are matched
    // against text it blanked, and listener callbacks are brace-matched on
    // it. So test it directly, on the shapes that break the naive version,
    // rather than inferring it worked from the scan having passed.
    const cases: [string, string, string][] = [
      // [source, comments blanked, comments and strings blanked]
      ["a; // canEditRoom()", 'a;                 ', 'a;                 '],
      ['a; /* canEditRoom() */ b;', 'a;                     b;', 'a;                     b;'],
      // A comment marker inside a string is not a comment: blanking from it
      // would wipe the rest of the line, including a gate standing after it.
      ["x('http://h'); canEditRoom();", "x('http://h'); canEditRoom();", 'x(          ); canEditRoom();'],
      // A quote inside a comment does not open a string.
      ["// don't\ncanEditRoom();", '        \ncanEditRoom();', '        \ncanEditRoom();'],
      // The case this test exists for: a gate that is only a message.
      ["showHint('canEditRoom() first');", "showHint('canEditRoom() first');", 'showHint(                     );'],
      // Templates: the text goes, the `${…}` is code and stays — so braces
      // stay balanced and the brace-matcher can count on the output.
      ['`a ${f({ x: 1 })} b`;', '`a ${f({ x: 1 })} b`;', '   ${f({ x: 1 })}   ;'],
      // Nested templates, which a non-nesting scanner reads inside out and
      // gets wrong from the first inner backtick onwards. editMode.ts has
      // one, at the 'Removed …' hint.
      ['`a${c ? `-${d}-` : ""}b`;', '`a${c ? `-${d}-` : ""}b`;', '  ${c ?   ${d}   :   }  ;'],
      // An escaped quote does not end the string.
      ["'it\\'s'; canEditRoom();", "'it\\'s'; canEditRoom();", '       ; canEditRoom();'],
      // ── Regex literals ──────────────────────────────────────────────────
      // The #198 audit's finding, and the reason the lexer grew a regex
      // branch. A regex is a literal, so its TEXT is not code — but it was
      // being read as code, and `//` inside one blanked to end of line in
      // BOTH modes. The write standing after it disappeared, the unit showed
      // no write, and the scan reported no leak. A silent pass is the one
      // outcome this file exists to prevent, so it is pinned by name.
      ['if (/\\/\\//.test(t)) writeCupolaWall(null);',
        'if (/\\/\\//.test(t)) writeCupolaWall(null);',
        'if (      .test(t)) writeCupolaWall(null);'],
      // A `[…]` class holds a bare `/` without ending the pattern, and a
      // bare `*` without opening a comment — this one used to swallow
      // everything up to the next `*/`, wherever in the file that was.
      ['if (/[/*]/.test(t)) canEditRoom();',
        'if (/[/*]/.test(t)) canEditRoom();',
        'if (      .test(t)) canEditRoom();'],
      // …and a quote without opening a string, which used to wipe to EOL and
      // take the `{`/`}` on that line with it — corrupting the brace count
      // the listener carver depends on.
      ['if (/[\'"]/.test(t)) canEditRoom();',
        'if (/[\'"]/.test(t)) canEditRoom();',
        'if (      .test(t)) canEditRoom();'],
      // The other direction, which is the harder half: division must NOT be
      // eaten as a pattern. Reading `/ 2; …` as a regex would blank through
      // the gate that follows it and manufacture coverage — a false NEGATIVE,
      // so the worse of the two mistakes. `(w - 1)` is a grouping, so the `/`
      // after its `)` divides; editMode.ts does this in ten places.
      ['const a = (w - 1) / 2; canEditRoom();',
        'const a = (w - 1) / 2; canEditRoom();',
        'const a = (w - 1) / 2; canEditRoom();'],
      // Whereas the `)` of an `if` head is not a value, so a `/` after THAT
      // one does open a pattern. The word before the `(` is the only thing
      // that separates these two lines.
      ['if (a) /x/.test(b);', 'if (a) /x/.test(b);', 'if (a)    .test(b);'],
      // A keyword is not a value either.
      ['return /x/.test(a);', 'return /x/.test(a);', 'return    .test(a);'],
      // `++` and `--` end a value where `+` and `-` begin one, so the
      // operator branch had them backwards: this line used to blank from
      // the first `/` to the second, swallowing the gate in between.
      ['i++ / 2; canEditRoom();', 'i++ / 2; canEditRoom();', 'i++ / 2; canEditRoom();'],
      ['i-- / 2; canEditRoom();', 'i-- / 2; canEditRoom();', 'i-- / 2; canEditRoom();'],
      // Prefix is the other direction and must still divide afterwards —
      // the `++` carries the operand position through, and `i` ends it.
      ['a = ++i / 2; canEditRoom();', 'a = ++i / 2; canEditRoom();',
        'a = ++i / 2; canEditRoom();'],
      // And a lone `+` must keep opening one, or the fix overshot.
      ['a = b + /x/.test(c);', 'a = b + /x/.test(c);', 'a = b +    .test(c);'],
    ];
    for (const [src, noComments, noStrings] of cases) {
      expect(blankOut(src, false), `comments: ${JSON.stringify(src)}`).toBe(noComments);
      expect(blankOut(src, true), `strings: ${JSON.stringify(src)}`).toBe(noStrings);
      // Length and newlines are load-bearing: every offset in the output is
      // the same offset in the input, which is what lets a gate's position
      // be compared with a write's.
      expect(blankOut(src, true).length, 'length changed').toBe(src.length);
    }

    // A scan that cannot read its input must say so. Each of these used to
    // return a plausible-looking blanked span instead: the unterminated
    // comment blanked to the end of the unit, taking every gate and every
    // write with it, and passed. Silence is the failure mode; a throw is the
    // repair.
    const refuses: [string, string][] = [
      ['a; /* never closed\ncanEditRoom();', 'unterminated block comment'],
      ['a; `never closed', 'unterminated template literal'],
      ["a; 'never closed\nb;", 'unterminated string literal'],
      ['a = /never closed\nb;', 'unterminated regex literal'],
      // `}` ends a block (a pattern may follow) or an object literal (a
      // division may), and telling those apart needs a parser. editMode.ts
      // has no `}` followed by a bare `/`, so this refuses rather than
      // guesses — guessing wrong one way blanks a gate, the other way a write.
      ['({ x: 1 }) ; } /re/.test(a);', 'cannot tell a regex literal from a division'],
    ];
    for (const [src, why] of refuses) {
      expect(() => blankOut(src, true), `should have refused: ${JSON.stringify(src)}`)
        .toThrow(why);
      expect(() => blankOut(src, false), `should have refused: ${JSON.stringify(src)}`)
        .toThrow(why);
    }

    // And on the real file, not just fixtures: blanking must leave the class
    // body's braces balanced, since that is what the carver counts.
    const cls = blankOut(SRC.slice(classAt, classEnd + 2), true);
    let depth = 0;
    for (const ch of cls) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    expect(depth, 'the class body does not brace-balance once blanked').toBe(0);
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
      new RegExp(`\\b${fn}${CALL}`).test(body);
    // Escaped: the gates contain '.' and '()', which are regex syntax.
    const GATE_RE = GATES.map((g) => new RegExp(g.replace(/[.()]/g, '\\$&')));
    const WRITER_RE = WRITERS.map((w) => new RegExp(`\\b${w}${CALL}`));
    const firstAt = (body: string, res: readonly RegExp[]): number => {
      const hits = res.map((r) => body.search(r)).filter((i) => i >= 0);
      return hits.length > 0 ? Math.min(...hits) : -1;
    };

    // A gate counts only if it comes BEFORE the first write in the same
    // slice. Containment alone would accept a check made after the doc has
    // already been mutated, which is not a check; it would also accept one
    // in an unrelated branch, which this still cannot tell apart — see the
    // limits noted at the top of this file.
    //
    // Gates are looked for in `gateBody` and writes in `body` — the same
    // span, blanked differently, so the two offsets stay comparable. Only
    // the gate side hides string text, and deliberately so: a write found
    // inside a message is a false positive that fails loudly and gets
    // fixed, while a gate found inside a message is a false negative that
    // quietly manufactures coverage. `showHint('ask canEditRoom() first')`
    // is not an owner check, and before this it counted as one.
    //
    // ⚠️ AND A WRITE IS NOT ONLY A WRITER'S NAME. The rule above compared
    // the gate against the first WRITERS call in the same slice, so in a
    // unit that performs no write of its own there was nothing to compare
    // against and the ordering test was skipped — a gate anywhere in the
    // body made it gated, including a gate that runs AFTER it has already
    // handed off:
    //
    //     private doThing(): void {
    //       this.applyLayout();          // writes; runs first, ungated
    //       if (!canEditRoom()) return;  // too late to matter
    //     }
    //
    // `doThing` names no writer, so it was gated; `applyLayout`'s only
    // caller was then covered, so the fixpoint covered it too. One
    // misplaced line laundered a gate onto a write that had already
    // happened. So the thing a gate must precede is the first EFFECT —
    // either a direct write or a call to a unit that reaches one — which
    // needs the call graph and reachability built first, below.
    //
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

    // Which units lead to a room-doc write, transitively. Note what this
    // does NOT depend on: gates. It is a property of the call graph and
    // WRITERS alone, which is why it can be built here, before anything
    // has been declared gated, and then used by both the ordering rule
    // below and the caller-rule premise further down.
    const nameOfId = new Map(units.map((u) => [idOf(u), u.name] as const));
    const reaches = new Set(units.filter((u) => WRITERS.some((w) => calls(u.body, w))).map(idOf));
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...reaches]) {
        for (const c of callersOf.get(id) ?? []) {
          if (!reaches.has(c)) { reaches.add(c); changed = true; }
        }
      }
    }

    /**
     * The same walk, but stopping at units that check for themselves: a
     * map from each unit that leads to a write WITH NO FURTHER OWNER
     * CHECK, to one concrete chain showing how. A self-gated unit is a
     * sink rather than an excused edge — it re-reads the gate at the
     * moment it acts, so nothing behind it inherits an answer to give,
     * however many hops back the caller sits. That distinction is the
     * whole difference between this and `reaches` above, and it is not
     * academic: the right-click handler calls cancelCarry, which five
     * hops later arrives at writeWallpaper through cycleWallpaperPreset —
     * a method whose first line is its own mayWriteRoomDoc() check, put
     * there (editMode.ts:4296-4302) precisely because a wallpaper panel
     * can sit open across a permission change. Nothing upstream of that
     * line has a question to answer, and a rule that said otherwise would
     * be demanding the weaker check in front of the stronger one.
     *
     * The chain string costs one entry per unit and buys the difference
     * between "delegated at line 1292" and a name-by-name route to the
     * write, which is the question a reader has at that point: the call
     * that counts as an effect is rarely one that looks like one.
     */
    const exposure = (selfGated: ReadonlySet<string>): Map<string, string> => {
      const via = new Map<string, string>();
      for (const u of units) {
        const w = WRITERS.find((x) => calls(u.body, x));
        if (w !== undefined && !selfGated.has(idOf(u))) via.set(idOf(u), w);
      }
      for (let changed = true; changed; ) {
        changed = false;
        for (const id of [...via.keys()]) {
          for (const c of callersOf.get(id) ?? []) {
            if (via.has(c) || selfGated.has(c)) continue;
            via.set(c, `${nameOfId.get(id)} → ${via.get(id)}`);
            changed = true;
          }
        }
      }
      return via;
    };

    /**
     * Where `u` first does something a gate was supposed to come before: a
     * direct writer call, or a call to a unit that reaches a write and
     * does not check for itself. `at` is -1 if it does neither, which is
     * the only case where a trailing gate is harmless. Offsets from `body`
     * and `callBody` are compared directly because the three views of a
     * unit are the same span with different characters blanked, never
     * re-indexed.
     *
     * `via` is an `exposure` map, and is why a call to a self-checking
     * callee does not count. Its own direct writes always do, however:
     * a unit that gates itself still has to do so before writing, or the
     * gate is a comment with parentheses. Only `gated` feeds `exposure`,
     * never `covered` — coverage is derived from callers, so letting it
     * stop the walk would be circular in exactly the direction that lets
     * a hole excuse itself.
     */
    const firstEffect = (u: Unit, via: ReadonlyMap<string, string>):
    { at: number; why: string } => {
      const self = idOf(u);
      const hits: { at: number; why: string }[] = [];
      const direct = firstAt(u.body, WRITER_RE);
      if (direct >= 0) {
        hits.push({ at: direct, why: `it writes (${WRITERS.find((w) => calls(u.body, w))})` });
      }
      for (const c of units) {
        const to = idOf(c);
        if (to === self || !via.has(to)) continue;
        const at = u.callBody.search(pattern.get(to)!);
        if (at >= 0) hits.push({ at, why: `it calls ${c.name} → ${via.get(to)}` });
      }
      // Earliest wins: a gate has to precede the FIRST effect, not some
      // effect. No seed — a `-1` one would compare as smaller than every
      // real offset and win every time, which is the no-effect answer
      // handed back for a unit full of effects.
      if (hits.length === 0) return { at: -1, why: '' };
      return hits.reduce((a, b) => (b.at < a.at ? b : a));
    };

    // Least fixpoint, climbing from "nothing checks for itself". Growing
    // the set can only turn calls into non-effects, never the reverse, so
    // each pass is monotone and this terminates — and starting from EMPTY
    // rather than from "everything holding a gate" is what makes it the
    // conservative answer: a ring of methods that each gate only after
    // calling the next never bootstraps itself in, where an optimistic
    // pass descending from the full set would have left the whole ring
    // marked. The same posture as the `covered` fixpoint below.
    const gated = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      const via = exposure(gated);
      for (const u of units) {
        const id = idOf(u);
        if (gated.has(id)) continue;
        const gate = firstAt(u.gateBody, GATE_RE);
        if (gate < 0) continue;
        const { at } = firstEffect(u, via);
        if (at < 0 || gate < at) { gated.add(id); changed = true; }
      }
    }
    const exposed = exposure(gated);
    const effectOf = new Map(units.map((u) => [idOf(u), firstEffect(u, exposed)] as const));

    // The ordering rule is clean when `exposed` is empty — and so is a
    // broken WRITERS list, a broken call graph, or an `exposure` whose
    // barrier swallowed everything. Name the set rather than counting it:
    // a floor is a guess at the scale, and the scale here is two. 196
    // units, 34 of which reach a write, 13 of which check before doing
    // it, and the barrier accounts for all the rest — which is what a
    // well-gated file is supposed to look like, and is only worth
    // believing if a change to it has to be read.
    //
    // Both survivors write directly with no check of their own
    // (deleteDoorLayout at :2725, deleteWindowLayout at :3147) and both
    // are excused by the caller rule below. That is not a coincidence,
    // it is the same fact twice: they are the units nothing but their
    // callers is protecting. A third name here is a third thing resting
    // on a premise that only holds while this file is the whole story.
    expect([...exposed.keys()].map((k) => nameOfId.get(k)).sort(),
      'the set of units that reach a room-doc write with no owner check of their own '
      + 'has changed')
      .toEqual(['removeSelectedDoor', 'removeSelectedWindow']);

    // And the barrier is load-bearing rather than decorative. This one
    // unit is what stands between the right-click handler at :1289 and a
    // reported late gate: cycleWallpaperPreset checks mayWriteRoomDoc()
    // at editMode.ts:4302 before writeWallpaper at :4306, so it must be
    // gated, must reach a write, and must NOT be exposed. If that ever
    // changes, :1289 starts failing again — and the fix is to read why,
    // not to move a check in front of a carry-cancel that is deliberately
    // allowed to a player who has just lost permission.
    const wp = units.filter((u) => u.name === 'cycleWallpaperPreset');
    expect(wp.length, 'cycleWallpaperPreset not found — the pin below is testing nothing').toBe(1);
    expect(gated.has(idOf(wp[0])), 'cycleWallpaperPreset no longer gates itself').toBe(true);
    expect(reaches.has(idOf(wp[0])), 'cycleWallpaperPreset no longer reaches a write').toBe(true);
    expect(exposed.has(idOf(wp[0])),
      'a unit that gates itself before writing must not be exposed to its callers').toBe(false);

    // A unit holding a gate it has already acted ahead of is worse than an
    // ungated one: the tightened rule above drops it out of `gated`, so
    // the hole does surface, but it surfaces as a leak somewhere down the
    // call chain, pointing at the callee rather than at the line that
    // actually needs moving. Name it here, where the diagnosis is exact.
    const lateGates = units
      .map((u) => ({ u, gate: firstAt(u.gateBody, GATE_RE), ...effectOf.get(idOf(u))! }))
      .filter(({ gate, at }) => gate >= 0 && at >= 0 && gate > at)
      .map(({ u, gate, at, why }) => `${u.label} checks the owner at line ${
        lineAt(u.start + gate)}, after line ${lineAt(u.start + at)}, where ${why}`
        + ' — move the check above that line, or gate the callee itself');
    expect(lateGates, lateGates.join('\n')).toEqual([]);

    // ── The other way an ordering can be a lie ───────────────────────────
    //
    // Everything above compares OFFSETS, which is a model of execution
    // that holds only while a unit runs start to finish. An `await` ends
    // that: the gate's answer was read before the suspension and the
    // write happens after it, with every other handler in the page free
    // to run in between — the same staleness the carved deferrals are
    // about, arriving inside one unit instead of across two.
    //
    // editMode.ts contains no `async` and no `await` today, both counted,
    // so this is a canary and not a repair. It is deliberately a canary:
    // extending the ordering model to suspension points properly means
    // deciding what a gate before an await is worth, and that is a
    // decision to make with the first real async writer in hand rather
    // than against an imagined one. What it must not do is pass quietly
    // on the day that writer arrives. It stays cheap for everyone else —
    // an async unit that neither writes nor reaches a write never fires.
    const stale = units
      .map((u) => ({ u, aw: u.gateBody.search(/\bawait\b/), ...effectOf.get(idOf(u))! }))
      .filter(({ aw, at }) => aw >= 0 && at >= 0)
      .map(({ u, aw, at, why }) => `${u.label} suspends at the await on line ${
        lineAt(u.start + aw)} and then reaches line ${lineAt(u.start + at)}, where ${why}`
        + ' — an owner check either side of a suspension is a check of a stale answer,'
        + ' and the offset comparisons in this test cannot model that. Extend them.');
    expect(stale, stale.join('\n')).toEqual([]);

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
      .map(({ u, writers }) => `${u.label} calls ${
        writers.join(', ')} with no owner check on any path`);

    expect(leaks, leaks.join('\n')).toEqual([]);

    // ── The premise the clean result above rests on ──────────────────────
    //
    // "Every caller is covered" excuses a unit from carrying a gate. The
    // excuse is only as good as the caller set behind it, and this scan
    // reads ONE FILE. A public method or an exported function can be
    // called from a module this graph never opened, by a caller that holds
    // no gate — and the fixpoint would still have marked it covered, on
    // the strength of the in-file callers it could see. The leak list
    // would be empty and the write would be unguarded.
    //
    // This is not academic: units are excused this way today and reach a
    // room-doc write. So check the premise rather than assuming it, in
    // both of the ways it can fail.
    // Reachability is transitive, so this asks about a unit that merely
    // leads to a write as well as one that performs it — an ungated public
    // step in front of a gated one is the same hole wearing a hat.
    const excused = units.filter((u) => {
      const id = idOf(u);
      return reaches.has(id) && covered.has(id) && !gated.has(id);
    });

    // Every sibling module, because the question is who else could call
    // one of these. Declaration files are skipped — a `.d.ts` states a
    // signature and calls nothing, so a name in one is a false match — and
    // so are the tests, which may legitimately reach for a private name.
    //
    // This reads RAW text, not `stripComments` output: the point is to
    // fail loudly on a name appearing anywhere outside this file, and a
    // call sitting in a comment or a string in another module is still
    // worth a human look. The error names the file, so a false positive
    // costs one glance.
    const elsewhere = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? elsewhere(join(d, e.name))
        : (/\.tsx?$/.test(e.name) && !/\.(?:test|d)\.tsx?$/.test(e.name)
          // By PATH, not by basename. This walk recurses — src/games and
          // src/network are below it today — so a basename test excludes
          // every editMode.ts in the tree, and the one it would exclude
          // by mistake is a sibling that could call these private names.
          // Skipping the file under scan is the point; skipping an
          // unrelated namesake is the hole.
          && join(d, e.name) !== SRC_PATH ? [join(d, e.name)] : [])));
    const others = elsewhere(DIR).map((f) => [f, readFileSync(f, 'utf8')] as const);
    expect(others.length, 'no sibling modules read, so the check below proves nothing')
      .toBeGreaterThan(20);

    const unsound: string[] = [];
    for (const u of excused) {
      const where = u.label;
      // (a) Declared reachable. `private` is erased at runtime, so this is
      //     a statement of intent rather than a guarantee — which is why
      //     (b) exists as well, and why neither is sufficient alone. Nor
      //     can they be: editMode.ts:4344 publishes the instance on
      //     `window.__roomEdit` as a permanent debug handle, so a console
      //     reaches every one of these in one line, and a console is in no
      //     file for (b) to read. That is the honest-client caveat at the
      //     top of this file arriving in person rather than a new hole —
      //     the handle is deliberate, and what these two arms are for is
      //     the SHIPPED caller set, which is where a regression comes from.
      const decl = SRC.slice(u.start, SRC.indexOf('\n', u.start));
      if (u.kind === 'member' && !/^\s*(?:private\b|protected\b|#)/.test(decl)) {
        unsound.push(`${where} is excused by its callers but is not private, so a call `
          + 'from another module reaches the write with no gate');
      }
      if (u.kind === 'function' && /^export\b/.test(decl)) {
        unsound.push(`${where} is excused by its callers but is exported, so a call `
          + 'from another module reaches the write with no gate');
      }
      // (b) Actually named somewhere else. A member is reached through a
      //     dot OR a string subscript, and a free function bare — the same
      //     split `callPattern` makes, see the collision between the two
      //     `isEditModeActive`s. The subscript half is what makes (a) and
      //     (b) independent: `private` is erased, so the one call shape
      //     that defeats arm (a) in a type-checked sibling is the one that
      //     is not spelled with a dot.
      const re = u.kind === 'member'
        ? new RegExp(`${MEMBER(u.name)}${CALL}`)
        : new RegExp(`(?<![.\\w$])${u.name}${CALL}`);
      for (const [file, text] of others) {
        if (re.test(text)) {
          unsound.push(`${where} is excused by its in-file callers, but ${
            file.slice(DIR.length + 1)} calls it too — a caller this scan never read`);
        }
      }
    }
    expect(unsound, `the caller rule is covering these on an incomplete caller set:\n${
      unsound.join('\n')}`).toEqual([]);

    // And the floor, because an empty `excused` list would pass the block
    // above while checking nothing. Named rather than counted: a count says
    // the premise is load-bearing, the names say WHICH units are riding on
    // it, and a unit newly riding on it is the one thing here worth a human
    // glance. Both directions fail loudly — one leaving means its gate or
    // its callers changed, one arriving means a write is now covered by an
    // argument rather than by a check.
    expect([...excused].map((u) => u.name).sort(),
      'the set of units excused by the caller rule has changed. Nothing is wrong yet — '
      + 'the block above still has to pass — but somebody should look at why')
      .toEqual(['ctxDelete', 'ctxMove', 'removeSelectedDoor', 'removeSelectedWindow']);
  });

  it('counts the writes it is actually guarding, so the scan cannot pass on nothing', () => {
    // If a rename made every WRITERS entry miss, the test above would pass with
    // an empty leak list. Pin the floor instead.
    const found = WRITERS.filter((w) => new RegExp(`\\b${w}${CALL}`).test(stripComments(SRC)));
    expect(found.length, `writers not found in editMode.ts: ${
      WRITERS.filter((w) => !found.includes(w)).join(', ')}`).toBe(WRITERS.length);

    // And every one of those calls has to land inside a slice, or the scan
    // never looked at it — it would not appear as a leak, it would appear as
    // nothing. This fired for real once: #184 merged `settleCupolaConflicts`,
    // a module-scope writer, into a file whose model knew only class members.
    // The answer was to teach the model about module-scope functions, not to
    // wave the call through, so what is left over here is now a shorter list:
    // a write at bare module scope, or inside a module-scope arrow const,
    // which no member slice and no function slice covers.
    //
    // A write nested INSIDE a slice is a different fault and this cannot
    // see it: the call is within the enclosing member’s offsets, so a unit
    // does contain it — the wrong one. The test straight after this is the
    // one that asks which.
    const bare = stripComments(SRC);
    const homeless: string[] = [];
    for (const w of WRITERS) {
      for (const hit of bare.matchAll(new RegExp(`\\b${w}${CALL}`, 'g'))) {
        const at = hit.index ?? 0;
        if (!units.some((u) => u.start <= at && at < u.end)) {
          homeless.push(`line ${lineAt(at)}: ${w}() is outside every member and function slice`);
        }
      }
    }
    expect(homeless, homeless.join('\n')).toEqual([]);
  });

  it('refuses a write in a nested callback, whose gate ran at some other time', () => {
    // `homeless` above asks whether ANY slice contains the call. This asks
    // whether the slice containing it is the one that RUNS it.
    //
    // A gate is checked by offset: a gate earlier in the slice covers a
    // write later in it. That holds for straight-line code and for an `if`,
    // a `for`, a `switch` or a `try`, every one of which runs where it is
    // written. It does not hold for a function body. Inside a gated method,
    //
    //     this.pending = () => { writeWallpaper(surface, next); };
    //
    // puts the write after the gate textually and at an arbitrary later
    // time in fact, and the scan scores it covered.
    //
    // The carvers lift five such shapes into units of their own — a
    // listener, a field handler, a timer, a promise continuation, a handler
    // property — and the exhaustiveness canary asks that every registration
    // SITE they know of be claimed by one of them. Neither reaches a
    // function body nobody registered: a callback handed to a method this
    // file has never heard of, an object-literal method, a helper put in a
    // local and passed on. This is the complement, and it needs no list of
    // shapes to ask its question — is the innermost function body holding
    // this write a unit, or is it borrowing one?
    //
    // Measured by the parse below rather than by a guess about it, and
    // re-measured when the parse replaced a walk that had been guessing:
    // editMode.ts has 164 braced function bodies, 34 of them inside
    // another, and 16 of those 34 belong to no carver. Of the 23 writer
    // calls, exactly one sits innermost in a nested body — the carved
    // 'click' listener at :2017, which is a unit already — and the other
    // twenty-two sit directly in a member or in settleCupolaConflicts. So
    // this reports nothing today and is one callback away from reporting,
    // which is what a canary is.
    //
    // A nested body that runs on the spot rather than later would be safe
    // anyway, so the shapes that do were counted — not the ones that came
    // to mind, but every call site in the file that hands a function
    // literal to a method, all forty-seven of them:
    //
    //     16  `.addEventListener`   deferred, the carver's business
    //      9  `.filter`     8  `.find`      4  `.some`
    //      2  `.map`        2  `.findIndex` 1  `.every`
    //      5  `.traverse`   THREE's own walk, and synchronous
    //
    // and no immediately-invoked function anywhere. So thirty-one bodies
    // run on the spot: twenty-six array callbacks, twenty-five of them
    // concise, and five `.traverse`, all braced. None holds a write, so
    // none is reported today. Adding concise bodies to `runsLater` below
    // took the array surface from one to twenty-six — the honest price of
    // closing the hole they hid — while `.traverse`'s five were braced
    // and in it all along.
    //
    // They still get no exception list, and `.traverse` is why starting
    // one would be a mistake rather than a chore. Asking whether a
    // receiver is an array was always a guess: knowing that needs a type,
    // this file can only read text, and a `.filter(` is wrong the moment
    // someone writes a `filter` of their own that defers. `.traverse`
    // shows the question was wrong too — not an array method, runs on the
    // spot, and five of the six braced synchronous bodies here. The list
    // would grow by API forever, and every entry is a silent pass when it
    // is wrong. So the rule stays the one that needs no types — a nested
    // body is a nested body — and the message below names the remedy
    // instead: lift the write out, or make the callback a unit this file
    // knows.
    //
    // Which braces open a function body is a question about the grammar,
    // and the grammar is not small enough to answer by looking backwards
    // from the brace. A hand-rolled walk stood here first and read the
    // parameter list, the `=>`, and an annotation stripped off with a
    // regex. It was wrong twelve times in this one file, and silently:
    // `getCarryCandidate(): { x: number; z: number; rot: Rot } | null {`
    // ends in a colon-bearing type, the strip bound to the colon in
    // `rot: Rot` instead of the one after `)`, and a real method body was
    // read as a block — while the same type's own `{ … }` was counted as a
    // body that is not one. Four misses and eight phantoms, and every
    // guard below stayed green through all twelve, because a phantom body
    // inside a method satisfies `bodiless` exactly as the real one would.
    //
    // So ask the compiler the package already builds with. `ts` is a
    // devDependency, this parses the TEXT already read off disk, and the
    // offsets it reports are offsets into that same text — the unit list
    // and the carver line up with it unchanged. Exact by construction, and
    // there is nothing left here to be wrong about.
    //
    // The parse itself is at module scope — `ast`, declared with the
    // class bounds — because the member canary needs the same tree and
    // two parses of one file are two chances to disagree.

    // And then ask whether that parse went well, because every check below
    // inherits the answer. This block first argued the question away: a
    // broken parse moves the body count, the count feeds `bodiless` and
    // `misaligned`, so corruption fails loudly there. Two of three cases
    // hold — a stray `(((` inside the class body takes 164 bodies to 169,
    // a file truncated in half to 65 — and the third does not. The same
    // `(((` appended at EOF leaves the count at exactly 164 and the file
    // passes, sixteen of sixteen. A silent pass, defended by a count that
    // cannot see it, in the file whose whole argument is that an unsound
    // check is worse than none.
    //
    // `parseDiagnostics`, on the node above, is the direct answer and is
    // not in the compiler's public types. `transpileModule` reaches the
    // same parser's complaints through types that are — `reportDiagnostics`
    // in, `diagnostics` out — and reaches them without a `Program`, which
    // is the part that matters: measured on this file it makes zero
    // `ts.sys` calls, resolves no import, reads nothing under
    // `node_modules`, and costs 238 ms. It parses the text a second time
    // rather than reporting on the node above, so it is handed the same
    // target; what it attests is that this text holds no syntax error,
    // which is exactly the claim being relied on.
    //
    // It reports the EOF case the count misses, at `4346: Expression
    // expected.` A false failure here would be worse than the gap, so the
    // legal constructs a later refactor might add were measured too:
    // `const enum`, `enum`, `namespace`, `declare`, `abstract`, a
    // decorator, a static block, `satisfies`, an `accessor` field, and a
    // type re-exported without `export type` — that last being the
    // complaint this route is known for. All ten report nothing.
    //
    // Five, because one syntax error cascades: the unbalanced `}` probe
    // reports 1116 of them and the first is the one worth reading.
    //
    // One more thing has to hold for any of that to mean anything: the
    // route has to still be reporting. `reportDiagnostics` is optional
    // going in and `diagnostics` is optional coming out, and dropping the
    // flag does not give the `undefined` the type suggests — measured, it
    // returns an empty array, which is exactly what a clean parse returns.
    // No null check separates those two. A later edit that trims the flag
    // as noise would leave this assert passing for ever on a file nobody
    // is checking any more, which is the shape of failure this file exists
    // to refuse. So both calls take their options from one builder — not
    // one object, it is called twice, but one place to delete the flag
    // from — and the first asks a question whose answer is known.
    const parseOpts = (fileName: string): ts.TranspileOptions => ({
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest },
    });
    const control = ts.transpileModule('const x = (((;', parseOpts('control.ts'))
      .diagnostics ?? [];
    expect(control.length, 'the syntax route reported nothing on text that '
      + 'cannot parse, so the assert below attests nothing either')
      .toBeGreaterThan(0);
    const syntax = ts.transpileModule(SRC, parseOpts(SRC_PATH)).diagnostics ?? [];
    const unparsed = syntax.slice(0, 5).map((d) => `${lineAt(d.start ?? 0)}: ${
      ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    // Asserted on the count, not on `unparsed`, which is a slice: narrow
    // that slice to nothing and an assert against `[]` is green for ever,
    // control and all. The slice is for reading; the count is the claim.
    expect(syntax.length, `the compiler rejects the text this scan parsed${
      syntax.length > 5 ? ` (${syntax.length} errors, first five)` : ''}:\n${
      unparsed.join('\n')}`).toBe(0);
    const bodies: { open: number; end: number }[] = [];
    // Function, method, constructor, getter, setter, arrow, function
    // expression: `isFunctionLike` is all seven. It also admits the
    // bodiless signature forms an interface can hold, which is what the
    // `in` is for — those have no `body` at all. A body that is present
    // but not a Block is a concise arrow, `() => expr`; it is left out
    // here because the two checks reading this list are about braces, and
    // picked up again in `runsLater` below, which is about what runs.
    //
    // A class static block is the one other thing in the grammar with a
    // braced body, and `isFunctionLike` does not admit it — it is not a
    // signature. It is deliberately NOT collected here. It was, for one
    // commit, and that was a weakening rather than the gap-closing it was
    // written up as: both checks reading this list ask whether SOME body
    // falls inside a span, so every entry added to it makes them easier to
    // satisfy, never harder. MEMBER_RE cannot start a unit at `  static {`,
    // which was offered as the reason the block was harmless — it is the
    // reason it was not. Unable to start a unit of its own, the block
    // falls inside the span of the member declared above it, and a
    // bodiless member above one, an overload signature say, stopped being
    // reported: vouched for by a brace that is not its own. Measured both
    // ways on exactly that shape — `bodiless` names `probeOverload` with
    // the block out of this list, and says nothing with it in.
    //
    // Which is the rule stated twenty lines below `runsLater`, reached
    // from the other side: this list is braces that are function bodies,
    // and folding anything else in lets a unit satisfy `bodiless` with
    // something that is not one. The block belongs in `runsLater`, which
    // asks what runs rather than what is a body, and it is collected
    // there.
    const collect = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) && 'body' in n && n.body !== undefined && ts.isBlock(n.body)) {
        bodies.push({ open: n.body.getStart(ast), end: n.body.end });
      }
      ts.forEachChild(n, collect);
    };
    collect(ast);

    // The parse has to have found the file, or every check below passes on
    // an empty list — and it has to be checked against something that fails
    // when it is half working, which a count of its own output never does.
    // The unit list is that something, once it is read properly: MEMBER_RE
    // claims data fields as well as methods, and a field has no body to
    // find — `private lastPointer = { x: 0, y: 0, has: false };` opens a
    // brace that is not a function body.
    //
    // So sort them first, and sort them by what the parser says the
    // declaration IS rather than by how its first line reads. Each member
    // unit runs from its own declaration to the next one, so exactly one
    // parsed member starts inside it: its own. Two things are demanded of
    // that pairing, and both are a failure rather than a bucket chosen in
    // passing — the parser must see a member there at all, and must agree
    // on its name. Both were put to the file to check they can speak. A
    // constructor parameter property wrapped onto its own line reaches
    // the first: `  private dep: number,` is a declaration at member
    // indentation that is not a class element, and MEMBER_RE claims it.
    // `  public get size(): number {` reaches the second: MEMBER_RE has
    // no `get` in it, so it captures `get` as the name, and until the
    // parser was asked, nothing in this file would have said so.
    const fnUnits: Unit[] = [];
    const unsorted: string[] = [];
    for (const u of units) {
      // A module-scope function and a carved callback are functions by
      // construction — one was cut at `function`, the other at a `{` the
      // carver brace-matched — so neither needs a member to vouch for it.
      if (u.kind === 'function' || u.carved) { fnUnits.push(u); continue; }
      const mine = parsed.filter((m) => u.start <= m.start && m.start < u.end)
        .sort((a, b) => a.start - b.start);
      const own = mine[0];
      if (own === undefined) {
        unsorted.push(`${u.label}: the parser sees no class member declared in its span`);
      } else if (own.name !== u.name) {
        unsorted.push(`${u.label}: the parser reads that declaration as ${
          own.name === '' ? `an unnamed ${own.what}` : own.name}`);
      } else {
        // Exactly one, not at least one. `own` is the FIRST member the
        // parser sees in the span and for years the rest were dropped,
        // which is precisely the fault the canary above now names from the
        // other end: a member MEMBER_RE cannot open a unit on is a member
        // sitting inside someone else's slice. Reported here as well
        // because this is where the consequence lands — the fold is what
        // decides whether `u` counts as a function or as data — and
        // because the two messages name different halves of it, the line
        // that went missing up there and the unit that swallowed it here.
        //
        // Same class only. A property holding a class expression has that
        // class's members inside its span and they are nobody's siblings;
        // `cls` is carried on each entry for this one comparison.
        for (const m of mine.filter((p) => p !== own && p.cls === own.cls)) {
          unsorted.push(`${u.label}: the parser declares ${
            m.name === '' ? `an unnamed ${m.what}` : `${m.name}, a ${m.what},`
          } at line ${lineAt(m.start)} inside this unit's span, and MEMBER_RE \
opened no unit on it, so everything it does is credited to this one's gate`);
        }
        if (own.fn) { fnUnits.push(u); }
      }
      // Anything left is a data field, and a field owes the parse nothing.
    }
    expect(unsorted, unsorted.join('\n')).toEqual([]);

    // And now the demand: every one of those owes the parse a body opening
    // inside its slice. This is not hypothetical, twice over. The first
    // draft asserted a floor of twenty bodies instead of this, and when an
    // annotation strip landed ON the `:` rather than before it, every
    // method written `): void {` was read as a block — the collection came
    // back holding the thirty-five arrows and nothing else, a fifth of the
    // file, and still cleared twenty. This check named all 111 of them.
    // It is kept now that a parser answers, because what it really asks is
    // whether the two machines still describe the same file: a unit list
    // that has drifted away from the source fails here just as loudly.
    const bodiless = fnUnits
      .filter((u) => !bodies.some((b) => u.start <= b.open && b.open < u.end))
      .map((u) => `${u.label}: the parse found no braced function body inside it`);
    expect(bodiless, bodiless.join('\n')).toEqual([]);

    // A concise arrow has no brace, so it is in none of the lists above —
    // and `const later = () => writeWallpaper(surface, next);` inside a
    // gated method is the same fault as the braced one, with nothing in
    // this file that caught it: the gate test sees a gated method, the
    // homeless check sees a call inside a unit, and a brace walk sees the
    // METHOD as the innermost body and waves it through. It is one span
    // the parser hands over for free, so take it.
    //
    // Kept apart from `bodies` rather than merged into it, because the two
    // cross-checks above are specifically about braces: a carved span ends
    // on one, and a unit holding a method must contain one. Folding these
    // in would let a unit satisfy `bodiless` with an expression.
    const runsLater = [...bodies];
    const collectConcise = (n: ts.Node): void => {
      if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) {
        runsLater.push({ open: n.body.getStart(ast), end: n.body.end });
      }
      ts.forEachChild(n, collectConcise);
    };
    collectConcise(ast);

    // The class static block, collected here instead of in `bodies`. It
    // runs once, at class-definition time — before any instance exists, so
    // earlier than any gate could have decided anything. Two things can sit
    // in one: a write, which is a hazard outright, and a listener
    // registration, which defers a body `nested` has to be able to see.
    // Neither is in editMode.ts today; collected anyway, because "there are
    // none" is the argument the brace walk above made.
    //
    // `runsLater` is the right list for both, and for the write it is not
    // enough on its own — which an earlier version of this comment claimed
    // it was. `borrowed` skips any host it cannot see as `nested`, and a
    // block at class top level sits in the class body, which is not a
    // function body and is therefore in no list here. It can never be
    // nested. Measured on the commit that added this collection, and the
    // numbers have since moved: an ungated write in a four-space-indented
    // block passed sixteen of sixteen in silence then, credited to the
    // gated member above it, because MEMBER_RE cannot open a unit at
    // `static {` and the block folded into that member's slice. The member
    // canary closes that from the other end now — it asks the parser for
    // the member list, a static block is in it, and a block MEMBER_RE
    // cannot carve is reported there at any indentation, write or no
    // write. What it reports is the missing slice, not the write. So the
    // block's own offsets are still kept below, and `borrowed` reads them
    // as a second reason a host has to answer: not nested, but running at
    // a time no gate reaches.
    //
    // The effect on the other reader runs the other way, and is worth saying
    // plainly rather than calling this a pure gain. `nested` has two
    // consumers of opposing polarity: `borrowed` reads `!nested.has(...)`
    // and skips, so growth strengthens it, while `misaligned` reads
    // `!nested.has(body.open)` and pushes, so growth SILENCES it. A listener
    // carved inside a block is reported without this collection and not with
    // it, and that report is not false — the carver credited the listener to
    // the member above the block, which did not register it, so "the parse
    // cannot see it inside the member registering it" is the literal truth
    // about a real mis-attribution. Collecting the block trades that true
    // report for the deferred-body nesting `borrowed` needs. Taken
    // deliberately, and cheap because the gate test still catches an ungated
    // write in such a listener — measured, both ways.
    //
    // And only the static block, because it is the only member the GRAMMAR
    // gives no name to. An earlier version of this comment said it was
    // "the only thing at class top level that is both unnestable and
    // unnameable", which is false: a generator `*gen()` is unnestable and
    // was just as invisible to MEMBER_RE. The difference is that `*gen()`
    // HAS a name and a pattern can be taught to open a unit on it, which
    // is how that hole was closed. `static {` offers no name in any
    // spelling, so no pattern can ever carve it and its offsets have to
    // come from the parse — which is this block.
    //
    // A property initialiser holding an arrow sits in the same place and
    // also never nests, but MEMBER_RE opens a unit on the name in front of
    // it, so it answers for its own gate and the gate test catches an
    // ungated write there. Measured on four shapes — a braced arrow, a
    // concise one, a public one, and one nested a level deeper — all four
    // caught, the first three by the gate test and the last by
    // `borrowed`'s ordinary nested arm.
    const staticOpens = new Set<number>();
    const collectStatic = (n: ts.Node): void => {
      if (ts.isClassStaticBlockDeclaration(n)) {
        const span = { open: n.body.getStart(ast), end: n.body.end };
        runsLater.push(span);
        staticOpens.add(span.open);
      }
      ts.forEachChild(n, collectStatic);
    };
    collectStatic(ast);

    const nested = new Set(runsLater
      .filter((b) => runsLater.some((o) => o.open < b.open && b.end <= o.end))
      .map((b) => b.open));

    // The carved spans are where the two machines have to meet, and they
    // have to meet on both counts: a carved span ends on the same `}` as the
    // callback body it carved, and it was found INSIDE a member, so the
    // parse must report a body with that end and must hold that body
    // nested. A disagreement turns every carved listener that writes into a
    // false report, and an empty list below would not tell that apart from
    // agreement. Eighteen carved spans assert the nesting half of the parse
    // here, so no floor below has to pick a number.
    const misaligned: string[] = [];
    for (const u of units.filter((h) => h.carved)) {
      const body = bodies.find((b) => b.end === u.end);
      if (body === undefined) {
        misaligned.push(`${u.label}: ends where no function body does`);
      } else if (!nested.has(body.open)) {
        misaligned.push(`${u.label}: the parse cannot see it inside the member registering it`);
      }
    }
    expect(misaligned, misaligned.join('\n')).toEqual([]);
    const carvedEnd = new Set(units.filter((u) => u.carved).map((u) => u.end));

    const bare = stripComments(SRC);
    const borrowed: string[] = [];
    for (const w of WRITERS) {
      for (const hit of bare.matchAll(new RegExp(`\\b${w}${CALL}`, 'g'))) {
        const at = hit.index ?? 0;
        // Innermost first: a nested arrow inside a carved listener is still
        // nested, and it is the arrow that answers, not the listener.
        //
        // `<=` because a concise arrow's body IS the call — `() =>
        // writeWallpaper(…)` starts the body and the write at the same
        // offset, and `<` read that arrow as not containing its own write.
        // A braced body cannot be caught by the widening: its `open` is a
        // `{`, and no writer call begins on one.
        const host = runsLater.filter((b) => b.open <= at && at < b.end)
          .sort((a, b) => b.open - a.open)[0];
        // No function body at all is module scope, which `homeless` owns;
        // a top-level body is a member or a module-scope function, which
        // the gate test owns; a carved body is a unit in its own right.
        //
        // A static block answers without being nested: nothing lexically
        // encloses it, and it still runs at a time no gate reaches.
        if (host === undefined
          || (!nested.has(host.open) && !staticOpens.has(host.open))
          || carvedEnd.has(host.end)) continue;
        const owner = units.filter((u) => u.start <= at && at < u.end)
          .sort((a, b) => b.start - a.start)[0];
        const where = staticOpens.has(host.open)
          ? `a class static block opening at line ${lineAt(host.open)}, which runs at `
            + 'class-definition time'
          : `a nested function opening at line ${lineAt(host.open)}`;
        borrowed.push(`line ${lineAt(at)}: ${w}() sits in ${where}, and is credited to ${
          owner?.label ?? 'no unit at all'}`);
      }
    }
    expect(borrowed, `${borrowed.join('\n')}\n\nEach of these is scored against a gate that `
      + 'ran when the function was created, not when its body runs. If the body runs later, '
      + "give it a unit of its own by teaching the carver its registration shape, so it "
      + 'answers for its own gate. If it runs where it is written, lift the write out of it: '
      + 'a `for` loop keeps the write in the method holding the gate, and says as much to a '
      + 'reader. A class static block is the third case and takes neither fix: it runs '
      + 'before any instance exists, so there is no gate to give it and nowhere to lift the '
      + 'write to. Move the write into a method that can be gated.').toEqual([]);
  });

  it('pins what editMode imports from the doc modules, so a new writer is noticed', () => {
    // The WRITERS list above is only as good as someone remembering to extend
    // it. This makes forgetting fail: add an import from one of these modules
    // and this test asks you which side of the line the new name is on.
    //
    // The list below is still hand-written, but it is no longer the only
    // thing standing between a new writer and a silent pass — see the
    // check after it, which derives the set of modules that MUST appear
    // here rather than trusting that someone added them.
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
      './robotDoc': ['clearRobotConfig', 'readRobotConfig'],
      // shipRoute transacts in ten places, but neither name editMode takes
      // is one of them: readShipRoute resolves a cached snapshot, and
      // routeRulesFlightNow (shipRoute.ts:1236) is a two-call read over one
      // — readRouteFlight (:1188) then routeRulesFlight, which is where the
      // type guard actually lives (pilotRoute.ts:1484, `f is RouteFlight`,
      // a null-and-paused test). Pinned so that importing one of the ten
      // would have to be argued for.
      './shipRoute': ['readShipRoute', 'routeRulesFlightNow'],
    };
    for (const [mod, names] of Object.entries(EXPECTED)) {
      // Value imports only — `import type { … }` can't be called.
      // EVERY braced import from the module, not the first one. `match`
      // without /g returns a single result, and a second
      // `import { … } from './floorPlanDoc'` is legal, is what a merge
      // leaves behind, and would have carried a new writer in behind a list
      // that still read as unchanged. Comments are stripped first, so a
      // commented-out import is not counted as one.
      //
      // The specifier is escaped because it goes into a RegExp:
      // `./doorLayoutDoc` as a pattern has three dots that match any
      // character, which is close enough to clear the wrong module.
      const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ms = [...stripComments(SRC).matchAll(
        new RegExp(`import\\s+\\{([^}]*)\\}\\s*from\\s*'${esc}'`, 'g'))];
      expect(ms.length, `no value import from ${mod}`).toBeGreaterThan(0);
      const got = [...new Set(ms.flatMap((x) => x[1]
        .split(',').map((y) => y.trim()).filter(Boolean)))].sort();
      expect(got, `${mod}: is any new name here a room-doc writer? If so add it to WRITERS`)
        .toEqual(names);
    }

    // The half the list above cannot do for itself.
    //
    // A pinned allowlist only guards the modules somebody already thought
    // of. `./robotDoc` proved it: it arrived in editMode.ts with #184's
    // merge, bringing `clearRobotConfig` — a real room-doc write, since
    // robotDoc is bound to the same Y.Doc as furniture and the floor plan
    // (`main.ts` bindRobotDoc(sync.doc)) — and because no key named it,
    // nothing above so much as looked. Neither list was wrong; the set of
    // lists was incomplete, which is the failure a hand-maintained
    // allowlist is always one import away from.
    //
    // So derive the obligation instead of trusting it: every relative
    // module editMode.ts imports VALUES from is read off disk, and any one
    // that can mutate a Yjs doc has to appear above. A new doc module then
    // cannot arrive unclassified — the test names it and asks.

    const unwatched: string[] = [];
    const unreadable: string[] = [];
    const relays: string[] = [];
    const seen = new Set<string>();
    for (const m of stripComments(SRC).matchAll(SPECIFIER)) {
      if (TYPE_ONLY.test(m[0])) continue;
      const mod = m[1];
      if (mod in EXPECTED || seen.has(mod)) continue;
      seen.add(mod);
      // Resolved the way the bundler would, not by assuming `<mod>.ts`:
      // a `./games/gamesDoc` or a directory with an index resolves too, and
      // `../` broke the old `mod.slice(2)` outright.
      const file = [`${mod}.ts`, `${mod}.tsx`, `${mod}/index.ts`, `${mod}/index.tsx`, mod]
        .map((c) => join(DIR, c)).find((c) => existsSync(c) && /\.tsx?$/.test(c));
      if (file === undefined) {
        // Not `continue`. A module this cannot read is a module it cannot
        // clear, and saying nothing about it is exactly the silence the
        // derived check was added to remove.
        unreadable.push(mod);
        continue;
      }
      // Two shapes, because `.transact(` alone was not the test it was
      // described as. The comment here used to say a module without one
      // "cannot mutate a shared doc, whatever it is called", and
      // directMessages.ts is the standing counterexample in this very
      // repo: zero transacts, a `sync.doc.getArray<DirectMessage>('dm')`
      // bound at :150 and `messages.push([…])` at :168. A transact is a
      // batching wrapper, not the write — binding a shared container is
      // what makes writes possible, so look for either.
      const body = stripComments(readFileSync(file, 'utf8'));
      if (/\.transact\s*\(|\.get(?:Map|Array|Text|XmlFragment)\s*(?:<[^;()]*>)?\s*\(/.test(body)) {
        unwatched.push(`${mod} (editMode takes ${
          m[0].match(/\{([^}]*)\}/)?.[1].trim().replace(/\s+/g, ' ') ?? 'the whole module'})`);
      }

      // A RELAY. The test just above asks whether the module can write
      // ITSELF; this asks whether it can hand a write on. A one-line
      // wrapper round writeDoorLayout names no Yjs, binds no container,
      // passes that test, and arrives in editMode.ts as an ordinary
      // helper with no gate owed. `./doorLayout` is one import away from
      // being exactly that today.
      //
      // Holding the name is the test because holding the name is
      // decidable from text, and "does this name reach a write" is not.
      // Three shapes of that walk were built and measured against this
      // tree while closing the #198 audit: a transitive module closure
      // (flags 14 of the 21 unpinned modules — noise, not a check), a
      // name-level call walk ending at a Yjs container op (3 hits, all
      // false, because casinoDoc's reads and writes share `ensureMap`),
      // and the same walk ending at a mutating method (3 hits, still all
      // false). Zero true positives between them. This arm finds 0 of 21
      // too, but it finds 0 soundly, so a 1 means something.
      //
      // A star re-export is reported on its own terms: it carries every
      // name the far module exports without spelling any of them, so
      // there is nothing here to match against.
      const held = WRITERS.filter((w) => new RegExp(`(?<![.\\w$])${w}\\b`).test(body));
      const stars = [...body.matchAll(/export\s*\*\s*from\s*'([^']+)'/g)];
      if (held.length > 0) {
        relays.push(`${mod} names ${held.join(', ')} — a wrapper or rename of a writer `
          + `reaches a room doc through it, and editMode takes ${
            m[0].match(/\{([^}]*)\}/)?.[1].trim().replace(/\s+/g, ' ') ?? 'the whole module'}`);
      }
      if (stars.length > 0) {
        relays.push(`${mod} re-exports * from ${stars.map((s) => s[1]).join(', ')}`
          + ' — every name behind that star is reachable through it and none is written here');
      }
    }
    expect(unreadable, `cannot read these modules, so cannot say whether they write.\n${
      'Resolve them here or pin them in EXPECTED:\n'}${unreadable.join('\n')}`).toEqual([]);
    expect(unwatched, `these modules can mutate a shared doc and are not pinned above.\n${
      'Add each to EXPECTED, and put any name that writes into WRITERS:\n'}${
      unwatched.join('\n')}`).toEqual([]);
    expect(relays, `these modules hold a room-doc writer without being a doc module.\n${
      'Pin each in EXPECTED, and if editMode takes a name that wraps the writer, put '}${
      'that name in WRITERS too:\n'}${relays.join('\n')}`).toEqual([]);

    // The sweep is only worth what it reaches, and "it found nothing" and
    // "it looked at nothing" read identically from here. So pin the floor:
    // editMode.ts imports from more than twenty relative modules, and a
    // SPECIFIER that stopped matching would quietly clear all of them.
    expect(seen.size + Object.keys(EXPECTED).length,
      'the specifier pattern has stopped finding imports').toBeGreaterThan(20);
  });

  it('sees every way a module can be imported, not just the braced one', () => {
    // editMode.ts contains two of the seven forms, so passing on editMode.ts
    // says nothing about the other five. The sweep that reads this pattern
    // decides which modules get examined for doc writes at all: a form it
    // walks past is a module nobody looks at, reported as clean.
    const found = (src: string): (string | null)[] => [...src.matchAll(SPECIFIER)]
      .filter((m) => !TYPE_ONLY.test(m[0])).map((m) => m[1]);

    expect(found("import { a, b } from './x';")).toEqual(['./x']);
    expect(found("import Foo from './d';")).toEqual(['./d']);
    expect(found("import Foo, { bar } from './mix';")).toEqual(['./mix']);
    expect(found("import * as ns from './ns';")).toEqual(['./ns']);
    expect(found("import './side';")).toEqual(['./side']);
    expect(found("export { a } from './re';")).toEqual(['./re']);
    expect(found("export * from './star';")).toEqual(['./star']);
    expect(found("const m = await import('./dyn');")).toEqual(['./dyn']);
    expect(found('import {\n  a,\n  b,\n} from "./multi";')).toEqual(['./multi']);
    expect(found("import { a } from './p/q/r';")).toEqual(['./p/q/r']);
    expect(found("import { a } from '../up';")).toEqual(['../up']);

    // Brings in no value, so nothing here can call a writer through it.
    expect(found("import type { T } from './t';")).toEqual([]);
    expect(found("export type { T } from './tt';")).toEqual([]);
    // Not relative: node_modules, and not this codebase's docs to classify.
    expect(found("import * as THREE from 'three';")).toEqual([]);
    // A specifier inside a string is not an import. The sweep hands this
    // comment-blanked source, so the one case left is a quoted one.
    expect(found("warn('import { a } from \\'./fake\\';');")).toEqual([]);

    // Consecutive statements stay separate, which is the thing the
    // line-wrapping branch could get wrong: a run-on match would report
    // the LAST specifier and skip every module named before it.
    expect(found("import { a } from './one';\nimport { b } from './two';"))
      .toEqual(['./one', './two']);
    expect(found("import {\n  a,\n} from './one'\nimport {\n  b,\n} from './two'"))
      .toEqual(['./one', './two']);
    // Including across a type-only statement, which is skipped by its own
    // match rather than by swallowing the one after it.
    expect(found("import type { T } from './t';\nimport { v } from './v';"))
      .toEqual(['./v']);
  });

  it('pins the World surface too, which no import check can reach', () => {
    // The blind spot the import check cannot cover, and the reason it
    // cannot: `./world` arrives as `import type { World }`. A type import
    // has no value to call, so skipping it there is right — but the VALUE
    // comes in by another door entirely, as enter()'s argument, kept in
    // `this.world`. Everything editMode asks the World to do is therefore
    // reachable without appearing in any import the derived sweep reads,
    // and `removeFurnitureVisuals` turned out to write two room docs one
    // level down. Nothing above would ever have said so.
    //
    // So pin this surface the same way, and make each name carry its own
    // answer. Adding a `world.…()` call then fails here until someone has
    // said which side of the line it is on.
    //
    // Verified by reading world.ts, not by the name: `refreshRobots` sounds
    // like the write that `removeFurnitureVisuals` actually is, and is not
    // one — reconcileRobots (world.ts:5187) disposes and spawns PoolWaiter
    // objects and calls applyRobotRoutines (:5517), which only READS
    // robotDoc. A name is not evidence either way.
    const WORLD_SURFACE: Record<string, boolean> = {
      // true ⇒ reaches a shared-doc write, so it must also be in WRITERS.
      // Fields are listed beside methods: a field is a door in the same
      // wall, and what editMode calls through one is pinned in WORLD_HOPS.
      removeFurnitureVisuals: true, // -> gamesDoc.clearTable, croupier.closeTable
      dockingSystem: false, // public field (world.ts:379); its methods are below
      furnitureGroups: false, // public Map field (world.ts:425)
      getClickPlane: false, // returns this.clickPlane (world.ts:4353)
      getPlayer: false, // returns this.player (world.ts:4349)
      getRemotePlayerPositions: false, // reads remotePlayers rig positions (:4333)
      getWindowGroups: false, // returns this.windowGroups (:1345)
      refreshOutdoorFloor: false, // rebuilds floor-cut geometry (:2770)
      refreshRobots: false, // local reconcile + a robotDoc READ (:5162)
      setEditMode: false, // toggles the platform grid (:6183)
      setHullEditView: false, // toggles wall visibility (:2077)
      windowClearsDoors: false, // a margin test over the door layout
    };
    // One hop further: what editMode calls on what the line above handed
    // back, and what it calls on the two fields. Keyed by the whole path,
    // because `get` on its own says nothing — the name that would go into
    // WRITERS is the tail, and the tail is what the cross-check reads.
    //
    // This stops at the second hop, and says so rather than implying more:
    // `dockingSystem?.getDoorGroups().get(id)` has a third, and a scan that
    // followed every chain would be a type checker. The second hop is where
    // the subsystem methods live, so it is where the answers are needed.
    const WORLD_HOPS: Record<string, boolean> = {
      'dockingSystem.getDoorGroups': false, // returns doorObjects (docking.ts:1147)
      'dockingSystem.isDoorPaired': false, // reads doorState (docking.ts:1156)
      'furnitureGroups.get': false, // Map read
      'furnitureGroups.has': false, // Map read
      'getClickPlane().parent': false, // THREE.Object3D field
      'getPlayer().onObstaclesChanged': false, // player.ts:1264, nav/path state only
      'getWindowGroups().get': false, // Map read
    };

    // `\bworld` rather than `this.world`: most call sites first resolve
    // `const world = this.world ?? worldProvider?.()`, and the spread form
    // `...world.getRemotePlayerPositions()` has a dot in front of it.
    //
    // The `\??` is not decoration. Without it this sweep could not see a
    // `this.world?.` hop at all, and nine of them exist — which is how
    // `getClickPlane` came to be called five times and classified never,
    // in a test whose entire purpose is to stop exactly that. A regex that
    // quietly matches less than the name it is named for is the same class
    // of bug as a lexer that guesses.
    //
    // Two views at the same offsets: names are read from `TEXT`, where
    // string text survives and a `world.` inside one is a loud false
    // positive worth the glance it costs, while parentheses are balanced in
    // `CODE`, where a `)` in a message cannot close a call that never
    // opened.
    const TEXT = stripComments(SRC);
    const CODE = blankOut(SRC, true);
    const NAME = '([A-Za-z_$][\\w$]*)(?![\\w$])';
    /** Just past the `)` closing the call whose `(` sits at `open`. */
    const closeOf = (open: number): number => {
      if (CODE[open] !== '(') throw new Error(`no call at offset ${open}`);
      for (let i = open, depth = 0; i < CODE.length; i += 1) {
        if (CODE[i] === '(') depth += 1;
        else if (CODE[i] === ')' && (depth -= 1) === 0) return i + 1;
      }
      throw new Error(`unbalanced call at line ${lineAt(open)}`);
    };

    // A hop is a call or it is a field — `(\()?` is what tells them apart,
    // and both have to be pinned. `furnitureGroups` and `dockingSystem` are
    // plain public fields, so a sweep for calls alone never saw either, and
    // `dockingSystem` is a whole second object editMode calls methods on.
    const calls = new Set<string>();
    const fields = new Set<string>();
    const chains = new Set<string>();
    for (const m of TEXT.matchAll(new RegExp(`\\bworld\\s*\\??\\.\\s*${NAME}\\s*(\\()?`, 'g'))) {
      if (m[2] === undefined) { fields.add(m[1]); continue; }
      calls.add(m[1]);
      const tail = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/
        .exec(CODE.slice(closeOf((m.index ?? -1) + m[0].length - 1)));
      if (tail) chains.add(`${m[1]}().${tail[1]}`);
    }
    for (const f of fields) {
      for (const h of TEXT.matchAll(
        new RegExp(`\\bworld\\s*\\??\\.\\s*${f}\\s*\\??\\.\\s*${NAME}`, 'g'))) {
        chains.add(`${f}.${h[1]}`);
      }
    }
    const asked = new Set([...calls, ...fields]);

    const unclassified = [...asked].filter((n) => !(n in WORLD_SURFACE)).sort();
    expect(unclassified, `editMode now asks the World for these. Does any of them reach a ${
      'room-doc write? If so add it to WRITERS as well:\n'}${unclassified.join('\n')}`)
      .toEqual([]);
    const unhopped = [...chains].filter((n) => !(n in WORLD_HOPS)).sort();
    expect(unhopped, `editMode now reaches these one hop past the World. Does any of ${
      'them write? If so add the tail to WRITERS as well:\n'}${unhopped.join('\n')}`)
      .toEqual([]);
    // And the other direction for both, so neither list can rot into a
    // record of calls that were removed years ago.
    expect([...Object.keys(WORLD_SURFACE)].filter((n) => !asked.has(n)).sort(),
      'listed here but no longer reached — drop it').toEqual([]);
    expect([...Object.keys(WORLD_HOPS)].filter((n) => !chains.has(n)).sort(),
      'listed here but no longer reached — drop it').toEqual([]);
    // A path's answer is about its tail, which is the name a gate scan
    // would see at the call site: `world.dockingSystem?.isDoorPaired(id)`
    // contains `isDoorPaired(`, so WRITERS can match it like any other.
    for (const [path, writes] of [...Object.entries(WORLD_SURFACE), ...Object.entries(WORLD_HOPS)]) {
      const name = path.slice(path.lastIndexOf('.') + 1);
      expect((WRITERS as readonly string[]).includes(name), writes
        ? `${path} reaches a room-doc write and must be in WRITERS`
        : `${path} does not write, so WRITERS claims a gate it does not need`).toBe(writes);
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
