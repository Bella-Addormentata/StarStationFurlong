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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The directory this test and editMode.ts share; the sibling modules too. */
const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(DIR, 'editMode.ts'), 'utf8');

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
const LISTENER_RE = new RegExp(
  `\\.addEventListener\\(\\s*${EVENT}\\s*,\\s*(?:async\\s+)?`
  + `(?:(?:${PARAMS}|[A-Za-z_$][\\w$]*)${RETTYPE}\\s*=>`
  + `|function\\s*(?:[A-Za-z_$][\\w$]*)?\\s*${PARAMS}${RETTYPE})\\s*\\{`,
  'g',
);

/**
 * The same registration, but stopping at the arrow — so a callback with a
 * CONCISE body (`() => writeWallpaper(x)`) matches this and not the pattern
 * above. There is no brace to match, so there is nothing to carve; the
 * canary below reports any that appear rather than letting one fold back
 * into the registering method and borrow its gate. editMode.ts has none.
 */
const INLINE_RE = new RegExp(
  `\\.addEventListener\\(\\s*${EVENT}\\s*,\\s*(?:async\\s+)?`
  + `(?:${PARAMS}|[A-Za-z_$][\\w$]*)${RETTYPE}\\s*=>`,
  'g',
);

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
  `\\bthis\\.([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s+)?`
  + `(?:${PARAMS}|[A-Za-z_$][\\w$]*)${RETTYPE}\\s*=>\\s*\\{`,
  'g',
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
        event: h[1] ?? h[2] ?? '?', start: offset + at, end: offset + j, closed, how,
      });
    }
  };
  carve(LISTENER_RE, 'listener');
  // Assigned handlers are named for the field, so a failure says which one.
  carve(FIELD_HANDLER_RE, 'handler');
  spans.sort((a, b) => a.start - b.start);

  // A registration whose callback is inline but has no brace to match: a
  // concise-body arrow. Nothing can be carved, so the body would stay in
  // the registering method and borrow its gate — the defect this carver
  // exists to close. Reported by the caller, never absorbed.
  const concise: { event: string; at: number }[] = [];
  for (const h of seen.matchAll(INLINE_RE)) {
    const at = h.index ?? 0;
    // The head, for the same reason the brace is checked above.
    if (code[at] !== '.') continue;
    if (!spans.some((l) => l.start === offset + at)) {
      concise.push({ event: h[1] ?? h[2] ?? '?', at: offset + at });
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
  for (const h of code.matchAll(/\.addEventListener\(/g)) {
    const at = h.index ?? 0;
    if (spans.some((l) => l.start === offset + at)) continue;
    if (concise.some((c) => c.at === offset + at)) continue;
    if (BY_REF_RE.test(seen.slice(at))) continue;
    unknown.push(offset + at);
  }
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
    carveFaults.push(`${m.name}: the '${c.event}' listener at line ${lineAt(c.at)
    } has a concise body, so it cannot be carved and is borrowing this method's gate`);
  }
  for (const at of unknown) {
    carveFaults.push(`${m.name}: the registration at line ${lineAt(at)
    } is in a callback shape this file does not know, so its body is still standing `
    + 'in this method holding a gate that ran when the listener was registered');
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
    // The class covers `[computed]` names, `'string'` names and `@decorator`
    // lines as well as identifiers. MEMBER_RE matches none of those three,
    // so without them here a member declared that way would fold into the
    // slice above it with nothing said — which is the single failure this
    // canary exists to make loud. editMode.ts has none of the three today.
    for (const m of SRC.slice(classAt, classEnd).matchAll(/^ {2}[A-Za-z_$#'"@[][^\n]*/gm)) {
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

    // The carver only ever looks inside members, so a registration written
    // at module scope is one it cannot reach — and `carveFaults` would stay
    // empty while saying nothing about it. All nineteen are in the class
    // today; this is what notices the twentieth if it is written outside.
    const stray = [...blankOut(SRC, true).matchAll(/\.addEventListener\(/g)]
      .map((h) => h.index ?? 0)
      .filter((at) => at < classAt || at > classEnd)
      .map((at) => `line ${lineAt(at)}: registered outside the class, so never carved`);
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

    // Named, not written: nothing to carve, and nothing wrong either. The
    // thing named is declared somewhere this scan already reads.
    for (const src of [
      "el.addEventListener('click', this.onMouseMove);",
      "el.addEventListener('click', this.ctxDismissKey, true);",
      "el.addEventListener('click', onClick.bind(this));",
    ]) {
      expect(one(src), src).toEqual({ spans: [], concise: [], unknown: [] });
    }

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
    //
    // Gates are looked for in `gateBody` and writes in `body` — the same
    // span, blanked differently, so the two offsets stay comparable. Only
    // the gate side hides string text, and deliberately so: a write found
    // inside a message is a false positive that fails loudly and gets
    // fixed, while a gate found inside a message is a false negative that
    // quietly manufactures coverage. `showHint('ask canEditRoom() first')`
    // is not an owner check, and before this it counted as one.
    const gated = new Set(units.filter((u) => {
      const gate = firstAt(u.gateBody, GATE_RE);
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
    const reaches = new Set(units.filter((u) => WRITERS.some((w) => calls(u.body, w))).map(idOf));
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...reaches]) {
        for (const c of callersOf.get(id) ?? []) {
          if (!reaches.has(c)) { reaches.add(c); changed = true; }
        }
      }
    }
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
          && e.name !== 'editMode.ts' ? [join(d, e.name)] : [])));
    const others = elsewhere(DIR).map((f) => [f, readFileSync(f, 'utf8')] as const);
    expect(others.length, 'no sibling modules read, so the check below proves nothing')
      .toBeGreaterThan(20);

    const unsound: string[] = [];
    for (const u of excused) {
      const where = `${u.name}() at line ${lineAt(u.start)}`;
      // (a) Declared reachable. `private` is erased at runtime, so this is
      //     a statement of intent rather than a guarantee — which is why
      //     (b) exists as well, and why neither is sufficient alone.
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
      //     dot and a free function bare, the same split `callPattern`
      //     makes — see the collision between the two `isEditModeActive`s.
      const re = u.kind === 'member'
        ? new RegExp(`\\.${u.name}\\s*\\(`) : new RegExp(`(?<![.\\w$])${u.name}\\s*\\(`);
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
    // above while checking nothing. The four that are excused and reach a
    // write — ctxMove, ctxDelete, removeSelectedDoor, removeSelectedWindow
    // — are what makes the premise load-bearing rather than decorative.
    expect(excused.length, 'nothing is excused by the caller rule any more, so the check '
      + 'above is vacuous — if that is genuinely true, delete it').toBeGreaterThan(0);
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
      // routeRulesFlightNow is a type guard over it (pilotRoute.ts). Pinned
      // so that importing one of the ten would have to be argued for.
      './shipRoute': ['readShipRoute', 'routeRulesFlightNow'],
    };
    for (const [mod, names] of Object.entries(EXPECTED)) {
      // Value imports only — `import type { … }` can't be called.
      const m = SRC.match(new RegExp(`import\\s+\\{([^}]*)\\}\\s*from\\s*'${mod}'`));
      expect(m, `no value import from ${mod}`).not.toBeNull();
      const got = m![1].split(',').map((x) => x.trim()).filter(Boolean).sort();
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
    }
    expect(unreadable, `cannot read these modules, so cannot say whether they write.\n${
      'Resolve them here or pin them in EXPECTED:\n'}${unreadable.join('\n')}`).toEqual([]);
    expect(unwatched, `these modules can mutate a shared doc and are not pinned above.\n${
      'Add each to EXPECTED, and put any name that writes into WRITERS:\n'}${
      unwatched.join('\n')}`).toEqual([]);

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
      removeFurnitureVisuals: true, // -> gamesDoc.clearTable, croupier.closeTable
      getPlayer: false, // returns this.player (world.ts:4349)
      getRemotePlayerPositions: false, // reads remotePlayers rig positions (:4333)
      getWindowGroups: false, // returns this.windowGroups (:1345)
      refreshOutdoorFloor: false, // rebuilds floor-cut geometry (:2770)
      refreshRobots: false, // local reconcile + a robotDoc READ (:5162)
      setEditMode: false, // toggles the platform grid (:6183)
      setHullEditView: false, // toggles wall visibility (:2077)
      windowClearsDoors: false, // a margin test over the door layout
    };
    // `\bworld\.` rather than `this.world.`: most call sites first resolve
    // `const world = this.world ?? worldProvider?.()`, and the spread form
    // `...world.getRemotePlayerPositions()` has a dot in front of it.
    const asked = new Set(
      [...stripComments(SRC).matchAll(/\bworld\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    );
    const unclassified = [...asked].filter((n) => !(n in WORLD_SURFACE)).sort();
    expect(unclassified, `editMode now asks the World for these. Does any of them reach a ${
      'room-doc write? If so add it to WRITERS as well:\n'}${unclassified.join('\n')}`)
      .toEqual([]);
    // And the other direction, so the list cannot rot into a record of
    // calls that were removed years ago.
    expect([...Object.keys(WORLD_SURFACE)].filter((n) => !asked.has(n)).sort(),
      'listed here but no longer called — drop it').toEqual([]);
    for (const [name, writes] of Object.entries(WORLD_SURFACE)) {
      expect((WRITERS as readonly string[]).includes(name), writes
        ? `${name} reaches a room-doc write and must be in WRITERS`
        : `${name} does not write, so WRITERS claims a gate it does not need`).toBe(writes);
    }

    // One level of chaining is reached too, and only one exists today.
    // Stated rather than swept, because a scan that followed every chain
    // would be a type checker; what this can honestly do is fail when a
    // second one appears and make someone look at it.
    const chained = [...stripComments(SRC).matchAll(/\bworld\.getPlayer\(\)\s*\.\s*(\w+)/g)]
      .map((m) => m[1]);
    expect([...new Set(chained)], 'a new Player call through the World — does it write?')
      .toEqual(['onObstaclesChanged']); // player.ts:1264, nav/path state only
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
