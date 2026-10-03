/**
 * Typing-focus guard tests — issue #188, "disable WASD when chatting".
 *
 * Two layers, because the bug needed both to be wrong at once:
 *
 *  1. `isTextEntryTarget` — the pure predicate. The vitest environment here
 *     is plain Node with no DOM, so the predicate takes a structural shape
 *     and the tests hand it plain objects, exactly as the real event targets
 *     would present themselves.
 *
 *  2. `InputManager` wiring — that the predicate is actually consulted on
 *     keydown, that keyup is deliberately NOT guarded, and that focus
 *     arriving in a text field drops keys that were already down. The last
 *     one is the half that a keydown-only guard misses: hold W, click the
 *     chat box, and the avatar keeps walking while you type.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTextEntryTarget } from './typingFocus';
import { InputManager } from './input';

describe('isTextEntryTarget', () => {
  it('treats a missing target as "not typing"', () => {
    // A keystroke that landed on the document with nothing focused.
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(undefined)).toBe(false);
  });

  it('lets ordinary elements through', () => {
    expect(isTextEntryTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'CANVAS' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false);
  });

  it('catches the chat box — a bare <input>, which is what #chat-input is', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
  });

  it('is insensitive to tag and type case', () => {
    expect(isTextEntryTarget({ tagName: 'input' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'input', type: 'CHECKBOX' })).toBe(false);
  });

  it('catches every <input> type that swallows typed characters', () => {
    for (const type of [
      'text',
      'search',
      'email',
      'url',
      'tel',
      'password',
      'number',
      'date',
      'time',
      'datetime-local',
      'month',
      'week',
    ]) {
      expect(isTextEntryTarget({ tagName: 'INPUT', type })).toBe(true);
    }
  });

  it('leaves <input> types that type nothing alone, so the player can still walk', () => {
    for (const type of [
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
    ]) {
      expect(isTextEntryTarget({ tagName: 'INPUT', type })).toBe(false);
    }
  });

  it('errs toward protecting typing for an input type it has never seen', () => {
    // Deliberate direction: a future/unknown type is assumed to accept text,
    // because leaking keystrokes into a field is the defect being fixed.
    expect(isTextEntryTarget({ tagName: 'INPUT', type: 'supertext' })).toBe(true);
  });

  it('catches textarea and select', () => {
    expect(isTextEntryTarget({ tagName: 'TEXTAREA' })).toBe(true);
    // Letters jump between options in a native select.
    expect(isTextEntryTarget({ tagName: 'SELECT' })).toBe(true);
  });

  it('catches contenteditable, including a node inside an editable host', () => {
    // `isContentEditable` is inherited, so a SPAN inside an editable div
    // reports true — and the keystroke is being typed either way.
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'SPAN', isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'SPAN', isContentEditable: false })).toBe(false);
  });
});

describe('InputManager honours the typing guard', () => {
  type Handler = (e: unknown) => void;
  let handlers: Record<string, Handler[]>;
  let input: InputManager;

  /** Fire a synthetic event at the listeners InputManager registered. */
  const fire = (type: string, event: unknown) => {
    for (const h of handlers[type] ?? []) h(event);
  };

  beforeEach(() => {
    handlers = {};
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: Handler) => {
        (handlers[type] ??= []).push(fn);
      },
    });
    input = new InputManager();
  });

  it('records a key pressed at the world', () => {
    fire('keydown', { key: 'w', target: { tagName: 'CANVAS' } });
    expect(input.isKeyPressed('w')).toBe(true);
  });

  it('ignores a key typed into the chat box', () => {
    fire('keydown', { key: 'w', target: { tagName: 'INPUT' } });
    fire('keydown', { key: 'a', target: { tagName: 'INPUT' } });
    fire('keydown', { key: 's', target: { tagName: 'INPUT' } });
    fire('keydown', { key: 'd', target: { tagName: 'INPUT' } });
    expect(input.isKeyPressed('w')).toBe(false);
    expect(input.isKeyPressed('a')).toBe(false);
    expect(input.isKeyPressed('s')).toBe(false);
    expect(input.isKeyPressed('d')).toBe(false);
  });

  it('does not fire an interaction for an "e" typed mid-word', () => {
    // The reason the guard sits at capture rather than in getMoveDirection:
    // isInteracting() reads the same set.
    fire('keydown', { key: 'e', target: { tagName: 'TEXTAREA' } });
    expect(input.isInteracting()).toBe(false);
  });

  it('still releases a key let go after focus moved into a field', () => {
    // Pressed at the world, released once the chat box had focus. If keyup
    // were guarded the same way keydown is, this key would stick down.
    fire('keydown', { key: 'w', target: { tagName: 'CANVAS' } });
    expect(input.isKeyPressed('w')).toBe(true);
    fire('keyup', { key: 'w', target: { tagName: 'INPUT' } });
    expect(input.isKeyPressed('w')).toBe(false);
  });

  it('drops keys already held when focus arrives in a text field', () => {
    // Hold W, then click the chat box. Without this, the guard stops new
    // presses but the walk already under way never ends.
    fire('keydown', { key: 'w', target: { tagName: 'CANVAS' } });
    fire('focusin', { target: { tagName: 'INPUT' } });
    expect(input.isKeyPressed('w')).toBe(false);
  });

  it('leaves held keys alone when focus moves to something that is not a field', () => {
    fire('keydown', { key: 'w', target: { tagName: 'CANVAS' } });
    fire('focusin', { target: { tagName: 'BUTTON' } });
    expect(input.isKeyPressed('w')).toBe(true);
  });

  it('drops everything when the window loses focus', () => {
    // Alt-tab delivers no keyup, so the key would stick down until the
    // player pressed and released it again.
    fire('keydown', { key: 'w', target: { tagName: 'CANVAS' } });
    fire('keydown', { key: 'shift', target: { tagName: 'CANVAS' } });
    fire('blur', {});
    expect(input.isKeyPressed('w')).toBe(false);
    expect(input.isKeyPressed('shift')).toBe(false);
  });
});
