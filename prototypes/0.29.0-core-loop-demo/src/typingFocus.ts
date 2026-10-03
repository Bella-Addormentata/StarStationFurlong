/**
 * Typing-focus guard
 *
 * One answer to the question "is this keystroke going into a surface the
 * player is typing in?", so that world input and hotkeys can stand aside
 * while a chat box, a rename field or a device panel has the keyboard.
 *
 * Deliberately free of DOM types and of three.js, so it is provable in this
 * project's pure-Node vitest environment: callers hand it an event target,
 * tests hand it a plain object carrying the same three fields.
 *
 * Callers must guard on the EVENT TARGET, never on `document.activeElement`
 * (#31's lesson, recorded in deviceFocus.ts: the room-name editor
 * replaceWith()s its input before the event bubbles, leaving activeElement
 * on <body> while the keystroke plainly belongs to the field being replaced).
 */

/**
 * `<input type>` values that do NOT swallow typed characters — pressing "w"
 * on a checkbox or a submit button types nothing, so world movement should
 * still run while one of those holds focus.
 *
 * Anything absent from this list counts as text entry, including a type this
 * list has never heard of. That direction is deliberate: the failure it
 * allows is "the avatar will not walk until the player clicks away from an
 * exotic input", which is visible and recoverable, against "keystrokes leak
 * into the world while writing a message" (#188), which is the defect this
 * module exists to stop.
 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * The shape of an event target this guard needs. A real `HTMLElement`
 * satisfies it structurally; so does `{ tagName: 'INPUT' }` in a test.
 */
export interface TextEntryTarget {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
}

/**
 * True when `target` is a surface that consumes typed characters.
 *
 * @param target the event's target — `null`/`undefined` is treated as "not
 *               typing", which is the right answer for a keystroke that
 *               landed on the document with nothing focused.
 */
export function isTextEntryTarget(
  target: TextEntryTarget | null | undefined,
): boolean {
  if (!target) return false;

  // `isContentEditable` is inherited, so this is true for a node INSIDE an
  // editable host as well as for the host itself — which is what we want:
  // the keystroke is being typed either way.
  if (target.isContentEditable === true) return true;

  switch ((target.tagName ?? '').toUpperCase()) {
    case 'TEXTAREA':
      return true;
    case 'SELECT':
      // Letters jump between options in a native select, so they are "in
      // use" here just as much as in a text field.
      return true;
    case 'INPUT':
      // An <input> with no type attribute is a text field.
      return !NON_TEXT_INPUT_TYPES.has((target.type ?? 'text').toLowerCase());
    default:
      return false;
  }
}
