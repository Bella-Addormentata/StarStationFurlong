/**
 * 🔑 Recovery-key backup nudge — pure decision engine (#79, PR #124 review 💡).
 *
 * Hermetic: no DOM, no localStorage, injected clocks. The storage adapter is
 * exercised through the in-memory Storage-shaped shim keypair.test.ts uses.
 */
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_NUDGE_SNOOZE_MS,
  RECOVERY_NUDGE_STORAGE_KEY,
  decideRecoveryNudge,
  dismissRecoveryNudge,
  emptyRecoveryNudgeRecord,
  isRecoveryKeyInHand,
  isRecoveryNudgeRecord,
  loadRecoveryNudgeRecord,
  noteIdentityValue,
  noteRecoveryKeyInHand,
  recoveryNudgeRecordFor,
  saveRecoveryNudgeRecord,
  snoozeRecoveryNudge,
} from './recoveryNudge';
import type { RecoveryNudgeRecord, RecoveryNudgeStore } from './recoveryNudge';

const ALICE = 'alice-pub';
const BOB = 'bob-pub';
const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Minimal Storage-shaped store; `broken` makes every method throw. */
class MemoryStore implements RecoveryNudgeStore {
  private map = new Map<string, string>();
  constructor(private readonly broken = false) {}
  getItem(k: string): string | null {
    if (this.broken) throw new Error('storage disabled');
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.broken) throw new Error('storage disabled');
    this.map.set(k, String(v));
  }
  raw(k: string): string | undefined {
    return this.map.get(k);
  }
  plant(k: string, v: string): void {
    this.map.set(k, v);
  }
}

const fresh = (pub = ALICE): RecoveryNudgeRecord => emptyRecoveryNudgeRecord(pub);
const withValue = (pub = ALICE, at = T0): RecoveryNudgeRecord => noteIdentityValue(fresh(pub), 'deed', at).record;
const reasonOf = (rec: RecoveryNudgeRecord, now: number): string => {
  const v = decideRecoveryNudge(rec, now);
  return v.show ? 'show' : v.reason;
};

describe('decideRecoveryNudge', () => {
  it('a fresh identity holds nothing → no nudge (reason no-value)', () => {
    expect(decideRecoveryNudge(fresh(), T0)).toEqual({ show: false, reason: 'no-value' });
  });

  it('value accrued and the key was never shown → show, with the first kind', () => {
    expect(decideRecoveryNudge(withValue(), T0 + 1)).toEqual({ show: true, kind: 'deed' });
  });

  it('key shown BEFORE any value → never nudges (the seed is constant per identity)', () => {
    const rec = noteIdentityValue(noteRecoveryKeyInHand(fresh(), T0 - HOUR), 'grant', T0).record;
    expect(decideRecoveryNudge(rec, T0 + 1)).toEqual({ show: false, reason: 'key-in-hand' });
  });

  it('key shown AFTER value → clears the nudge', () => {
    const rec = noteRecoveryKeyInHand(withValue(), T0 + 1);
    expect(decideRecoveryNudge(rec, T0 + 2)).toEqual({ show: false, reason: 'key-in-hand' });
  });

  it("DON'T ASK AGAIN is permanent for the identity", () => {
    const rec = dismissRecoveryNudge(withValue(), T0 + 1);
    expect(decideRecoveryNudge(rec, T0 + 365 * 24 * HOUR)).toEqual({ show: false, reason: 'dismissed' });
  });

  it('LATER hides the banner for exactly the snooze window and shows again AT the boundary', () => {
    const rec = snoozeRecoveryNudge(withValue(), T0 + 1);
    expect(rec.snoozedUntil).toBe(T0 + 1 + RECOVERY_NUDGE_SNOOZE_MS);
    expect(decideRecoveryNudge(rec, T0 + 1)).toEqual({ show: false, reason: 'snoozed' });
    expect(decideRecoveryNudge(rec, rec.snoozedUntil - 1)).toEqual({ show: false, reason: 'snoozed' });
    expect(decideRecoveryNudge(rec, rec.snoozedUntil)).toEqual({ show: true, kind: 'deed' });
  });

  it('precedence: key-in-hand > no-value > dismissed > snoozed', () => {
    const everything = noteRecoveryKeyInHand(dismissRecoveryNudge(snoozeRecoveryNudge(withValue(), T0), T0), T0);
    expect(reasonOf(everything, T0)).toBe('key-in-hand');
    const noValueButAnswered = dismissRecoveryNudge(snoozeRecoveryNudge(fresh(), T0), T0);
    expect(reasonOf(noValueButAnswered, T0)).toBe('no-value');
    expect(reasonOf(dismissRecoveryNudge(snoozeRecoveryNudge(withValue(), T0), T0), T0)).toBe('dismissed');
    expect(reasonOf(snoozeRecoveryNudge(withValue(), T0), T0)).toBe('snoozed');
  });

  it('a value stamp without a kind (planted / future schema) still shows, with generic copy', () => {
    const rec: RecoveryNudgeRecord = { ...fresh(), firstValueAt: T0 };
    expect(decideRecoveryNudge(rec, T0)).toEqual({ show: true, kind: '' });
  });

  it('the snooze window is one day', () => {
    expect(RECOVERY_NUDGE_SNOOZE_MS).toBe(24 * HOUR);
  });
});

describe('noteIdentityValue — first accrual only', () => {
  it('stamps the first call and reports first=true', () => {
    const { record, first } = noteIdentityValue(fresh(), 'shares', T0);
    expect(first).toBe(true);
    expect(record.firstValueAt).toBe(T0);
    expect(record.firstValueKind).toBe('shares');
  });

  it('a later seam (any kind, any time) keeps the first moment and reports first=false', () => {
    const a = noteIdentityValue(fresh(), 'deed', T0).record;
    const b = noteIdentityValue(a, 'cohost', T0 + HOUR);
    expect(b.first).toBe(false);
    expect(b.record).toBe(a); // same object — nothing new to persist
    expect(b.record.firstValueAt).toBe(T0);
    expect(b.record.firstValueKind).toBe('deed');
  });

  it('every transition leaves its input untouched', () => {
    const a = fresh();
    noteIdentityValue(a, 'grant', T0);
    noteRecoveryKeyInHand(a, T0);
    snoozeRecoveryNudge(a, T0);
    dismissRecoveryNudge(a, T0);
    expect(a).toEqual(fresh());
  });

  it('floors a fractional clock and clamps a non-finite one so the stored record survives the guard', () => {
    expect(noteIdentityValue(fresh(), 'deed', T0 + 0.9).record.firstValueAt).toBe(T0);
    const nan = noteIdentityValue(fresh(), 'deed', Number.NaN).record;
    expect(isRecoveryNudgeRecord(nan)).toBe(true);
    expect(nan.firstValueAt).toBeGreaterThan(0);
    expect(isRecoveryNudgeRecord(noteRecoveryKeyInHand(fresh(), Number.POSITIVE_INFINITY))).toBe(true);
    expect(isRecoveryNudgeRecord(snoozeRecoveryNudge(fresh(), -5))).toBe(true);
  });
});

describe('noteRecoveryKeyInHand', () => {
  it('stamps the reveal and leaves the value markers intact', () => {
    const rec = noteRecoveryKeyInHand(withValue(), T0 + 5);
    expect(isRecoveryKeyInHand(rec)).toBe(true);
    expect(rec.keyInHandAt).toBe(T0 + 5);
    expect(rec.firstValueAt).toBe(T0);
    expect(rec.firstValueKind).toBe('deed');
  });

  it('is monotonic — a clock stepped backwards cannot roll the marker back', () => {
    const rec = noteRecoveryKeyInHand(noteRecoveryKeyInHand(fresh(), T0), T0 - HOUR);
    expect(rec.keyInHandAt).toBe(T0);
  });

  it('a fresh identity has no key in hand', () => {
    expect(isRecoveryKeyInHand(fresh())).toBe(false);
  });
});

describe('recoveryNudgeRecordFor — one record per identity', () => {
  it('returns the stored record for the same identity, rebuilt from its fields (extras dropped)', () => {
    const stored = { ...withValue(), extra: 'planted' };
    const rec = recoveryNudgeRecordFor(stored, ALICE);
    expect(rec).toEqual(withValue());
    expect('extra' in rec).toBe(false);
  });

  it("another identity's record reads as absent — its reveal, snooze and dismissal do not carry over", () => {
    const alice = dismissRecoveryNudge(snoozeRecoveryNudge(noteRecoveryKeyInHand(withValue(), T0), T0), T0);
    const forBob = recoveryNudgeRecordFor(alice, BOB);
    expect(forBob).toEqual(fresh(BOB));
    expect(decideRecoveryNudge(forBob, T0)).toEqual({ show: false, reason: 'no-value' });
  });

  it('restore-from-backup: the new identity starts clean, and the paste itself counts as key-in-hand', () => {
    const alice = withValue(); // the old identity, nudging
    expect(decideRecoveryNudge(alice, T0).show).toBe(true);
    const bob = noteRecoveryKeyInHand(recoveryNudgeRecordFor(alice, BOB), T0 + 1); // Bob's key was pasted
    const bobWithValue = noteIdentityValue(bob, 'deed', T0 + 2).record;
    expect(decideRecoveryNudge(bobWithValue, T0 + 3)).toEqual({ show: false, reason: 'key-in-hand' });
  });
});

describe('isRecoveryNudgeRecord — shape guard', () => {
  const good = withValue();

  it('accepts a well-formed record, with or without value', () => {
    expect(isRecoveryNudgeRecord(good)).toBe(true);
    expect(isRecoveryNudgeRecord(fresh())).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['an array', []],
    ['wrong version', { ...good, v: 2 }],
    ['empty pub', { ...good, pub: '' }],
    ['non-string pub', { ...good, pub: 7 }],
    ['negative stamp', { ...good, keyInHandAt: -1 }],
    ['fractional stamp', { ...good, firstValueAt: T0 + 0.5 }],
    ['NaN stamp', { ...good, snoozedUntil: Number.NaN }],
    ['unsafe integer', { ...good, dismissedAt: Number.MAX_SAFE_INTEGER + 2 }],
    ['string stamp', { ...good, firstValueAt: String(T0) }],
    ['unknown kind', { ...good, firstValueKind: 'chips' }],
    ['missing field', { v: 1, pub: ALICE, keyInHandAt: 0, firstValueAt: 0, firstValueKind: '', dismissedAt: 0 }],
  ])('rejects %s', (_label, value) => {
    expect(isRecoveryNudgeRecord(value)).toBe(false);
  });
});

describe('storage adapter', () => {
  it('round-trips through a Storage-shaped store under the documented key', () => {
    const store = new MemoryStore();
    const rec = snoozeRecoveryNudge(withValue(), T0);
    expect(saveRecoveryNudgeRecord(store, rec)).toBe(true);
    expect(store.raw(RECOVERY_NUDGE_STORAGE_KEY)).toBe(JSON.stringify(rec));
    expect(loadRecoveryNudgeRecord(store, ALICE)).toEqual(rec);
  });

  it('a record saved for one identity loads as absent for another', () => {
    const store = new MemoryStore();
    saveRecoveryNudgeRecord(store, withValue());
    expect(loadRecoveryNudgeRecord(store, BOB)).toEqual(fresh(BOB));
  });

  it('an empty store reads as "never"', () => {
    expect(loadRecoveryNudgeRecord(new MemoryStore(), ALICE)).toEqual(fresh());
  });

  it('corrupt JSON and wrong-shape JSON read as "never" without throwing', () => {
    const store = new MemoryStore();
    store.plant(RECOVERY_NUDGE_STORAGE_KEY, '{not json');
    expect(() => loadRecoveryNudgeRecord(store, ALICE)).not.toThrow();
    expect(loadRecoveryNudgeRecord(store, ALICE)).toEqual(fresh());
    store.plant(RECOVERY_NUDGE_STORAGE_KEY, JSON.stringify({ v: 1, pub: ALICE, keyInHandAt: 'yes' }));
    expect(loadRecoveryNudgeRecord(store, ALICE)).toEqual(fresh());
  });

  it('a null store (privacy mode) reads as "never" and refuses to save', () => {
    expect(loadRecoveryNudgeRecord(null, ALICE)).toEqual(fresh());
    expect(saveRecoveryNudgeRecord(null, withValue())).toBe(false);
  });

  it('a throwing store never propagates — load reads "never", save reports false', () => {
    const store = new MemoryStore(true);
    expect(() => loadRecoveryNudgeRecord(store, ALICE)).not.toThrow();
    expect(loadRecoveryNudgeRecord(store, ALICE)).toEqual(fresh());
    expect(() => saveRecoveryNudgeRecord(store, withValue())).not.toThrow();
    expect(saveRecoveryNudgeRecord(store, withValue())).toBe(false);
  });
});
