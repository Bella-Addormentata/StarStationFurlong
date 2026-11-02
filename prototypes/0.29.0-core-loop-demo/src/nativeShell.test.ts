/**
 * 🖥️ The desktop app's commands as the page sees them: whether the page runs
 * inside the app, and OPEN BACKUP WINDOW's call, which sends no argument and
 * reads back only a fixed answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_BACKUP_ANSWERS, hasNativeShell, openBackup } from './nativeShell';

const withInternals = (internals: unknown) => vi.stubGlobal('window', { __TAURI_INTERNALS__: internals });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasNativeShell', () => {
  it('is false with no window at all (a test, a worker)', () => {
    expect(typeof window).toBe('undefined');
    expect(hasNativeShell()).toBe(false);
  });

  it('is true only when the app\'s invoke hook is a function', () => {
    vi.stubGlobal('window', {});
    expect(hasNativeShell()).toBe(false);
    for (const internals of [undefined, null, {}, { invoke: 'open_backup' }, { invoke: {} }, 7]) {
      withInternals(internals);
      expect(hasNativeShell()).toBe(false);
    }
    withInternals({ invoke: () => undefined });
    expect(hasNativeShell()).toBe(true);
  });

  it('is false, and openBackup unavailable, when reading the hook throws', async () => {
    // A page script or an extension can put a throwing getter on either
    // the internals object or its invoke: the Bank's render must not break.
    const throwingInternals = {};
    Object.defineProperty(throwingInternals, '__TAURI_INTERNALS__', {
      get() {
        throw new Error('no internals');
      },
    });
    const throwingInvoke = {};
    Object.defineProperty(throwingInvoke, 'invoke', {
      get() {
        throw new Error('no invoke');
      },
    });
    for (const win of [throwingInternals, { __TAURI_INTERNALS__: throwingInvoke }]) {
      vi.stubGlobal('window', win);
      expect(() => hasNativeShell()).not.toThrow();
      expect(hasNativeShell()).toBe(false);
      await expect(openBackup()).resolves.toBe('unavailable');
    }
  });
});

describe('openBackup', () => {
  it('is unavailable outside the app, and calls nothing', async () => {
    expect(await openBackup()).toBe('unavailable');
    vi.stubGlobal('window', {});
    expect(await openBackup()).toBe('unavailable');
  });

  it('invokes open_backup with no argument at all', async () => {
    const invoke = vi.fn(async () => 'closed');
    withInternals({ invoke });
    expect(await openBackup()).toBe('closed');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(['open_backup']);
  });

  it('passes each of the eight answers through as itself', async () => {
    expect(NATIVE_BACKUP_ANSWERS).toEqual(['saved', 'closed', 'no_channel', 'other_network', 'not_on', 'turning', 'already_saved', 'busy']);
    for (const answer of NATIVE_BACKUP_ANSWERS) {
      withInternals({ invoke: async () => answer });
      expect(await openBackup()).toBe(answer);
    }
  });

  it('reads a refusal, a throw, an unknown answer or anything not a string as unavailable', async () => {
    withInternals({ invoke: async () => { throw new Error('command open_backup not found'); } });
    expect(await openBackup()).toBe('unavailable');
    withInternals({ invoke: () => { throw new Error('sync'); } });
    expect(await openBackup()).toBe('unavailable');
    withInternals({ invoke: () => Promise.reject('not allowed') });
    expect(await openBackup()).toBe('unavailable');
    for (const odd of ['SAVED', 'saved ', 'opened', '', 'unavailable', undefined, null, 1, true, ['saved'], { answer: 'saved' }, { words: ['zorbel', 'quindle'] }]) {
      withInternals({ invoke: async () => odd });
      expect(await openBackup()).toBe('unavailable');
    }
  });

  it('returns a plain answer, never what the app sent beside it', async () => {
    withInternals({ invoke: async () => ({ toString: () => 'saved' }) });
    const answer = await openBackup();
    expect(answer).toBe('unavailable');
    expect(typeof answer).toBe('string');
  });
});
