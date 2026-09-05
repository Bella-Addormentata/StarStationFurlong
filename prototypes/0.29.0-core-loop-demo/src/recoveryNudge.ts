/**
 * 🔑 Recovery-key backup nudge — pure decision engine (#79, PR #124 review 💡).
 *
 * WHY. The Ed25519 seed in localStorage IS the identity (keypair.ts): there
 * is no recovery service, and the seed is exportable precisely so the player
 * can back it up — but nothing prompted them to. The review's ask: prompt
 * "before their identity accrues value — a first-grant or first-deed moment
 * is the natural trigger". This module decides WHEN to prompt; main.ts owns
 * the DOM, the clock and the storage handle.
 *
 * WHAT COUNTS AS VALUE — anything the game keys to the IDENTITY, which a
 * lost device therefore takes with it: a deed (room ownership resolves to the
 * pub behind the owner's players entry), a door build-rights grant (doorPolicy
 * grants are keyed by pub), a co-host seat (roomRoles, keyed by pub), and
 * venture shares (the cap table is keyed by pub). Chips are deliberately NOT
 * a trigger — they are playerId-keyed (casinoDoc), so a backup would not
 * carry them and nudging for them would over-promise.
 *
 * ONE RECORD PER IDENTITY. Markers are scoped to the pub they were written
 * for: a restore-from-backup swaps the identity, and the old identity's
 * "key in hand" must not vouch for the new one (nor its snooze silence it).
 * A record whose pub differs from the live identity reads as absent.
 *
 * "IN HAND", NOT "VERIFIED". We can only know the recovery key was SHOWN
 * (Contacts → Reveal) or PASTED (a successful restore proves possession).
 * Whether the player actually stored it somewhere safe is unknowable here,
 * so the player-facing copy never says "saved" — it says the key was shown.
 *
 * PURE. No DOM, no clock, no storage access: every decision takes `now` and
 * a record; the adapter at the bottom takes a Storage-shaped store so vitest
 * exercises it with an in-memory map (the keypair.test.ts pattern).
 */

/** Which identity-keyed holding accrued first — drives the banner copy. */
export type IdentityValueKind = 'deed' | 'grant' | 'cohost' | 'shares';

const VALUE_KINDS: readonly string[] = ['deed', 'grant', 'cohost', 'shares'];

export interface RecoveryNudgeRecord {
  /** Schema version — a mismatch reads as absent (a nudge needs no migration). */
  readonly v: 1;
  /** The identity (base64url pub) these markers belong to. */
  readonly pub: string;
  /** ms epoch the recovery key was last in the player's hands (revealed or pasted); 0 = never. */
  readonly keyInHandAt: number;
  /** ms epoch this identity FIRST accrued value; 0 = not yet. */
  readonly firstValueAt: number;
  /** What accrued first; '' until `firstValueAt` is set. */
  readonly firstValueKind: IdentityValueKind | '';
  /** ms epoch until which LATER silences the banner; 0 = not snoozed. */
  readonly snoozedUntil: number;
  /** ms epoch of DON'T ASK AGAIN; 0 = never. The identity-row cue is unaffected. */
  readonly dismissedAt: number;
}

export type RecoveryNudgeVerdict =
  | { show: false; reason: 'key-in-hand' | 'no-value' | 'dismissed' | 'snoozed' }
  | { show: true; kind: IdentityValueKind | '' };

/** localStorage key. One record — the live identity's — is all that is kept. */
export const RECOVERY_NUDGE_STORAGE_KEY = 'ssf-recovery-nudge';

/**
 * LATER hides the banner for a day: long enough not to nag, short enough
 * that "I'll do it later" cannot quietly become never.
 */
export const RECOVERY_NUDGE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export function emptyRecoveryNudgeRecord(pub: string): RecoveryNudgeRecord {
  return { v: 1, pub, keyInHandAt: 0, firstValueAt: 0, firstValueKind: '', snoozedUntil: 0, dismissedAt: 0 };
}

/** A non-negative safe integer — what every timestamp field must be. */
function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Shape guard for a parsed record. Strict on TYPES — anything else reads as
 * absent, because a corrupt or planted value must never throw into a click
 * handler, nor silence the nudge by accident. Tolerant on cross-field
 * consistency: a `firstValueAt` without a kind still shows, with generic copy.
 */
export function isRecoveryNudgeRecord(value: unknown): value is RecoveryNudgeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<RecoveryNudgeRecord>;
  return (
    r.v === 1 &&
    typeof r.pub === 'string' &&
    r.pub.length > 0 &&
    isStamp(r.keyInHandAt) &&
    isStamp(r.firstValueAt) &&
    (r.firstValueKind === '' || VALUE_KINDS.includes(r.firstValueKind as string)) &&
    isStamp(r.snoozedUntil) &&
    isStamp(r.dismissedAt)
  );
}

/**
 * The record that applies to the LIVE identity: the stored one if it passes
 * the guard AND belongs to `pub`, else a fresh empty record for `pub`. This is
 * what scopes every marker to one identity (module header). The result is
 * rebuilt field-by-field so nothing extra a planted value carried survives.
 */
export function recoveryNudgeRecordFor(stored: unknown, pub: string): RecoveryNudgeRecord {
  if (!isRecoveryNudgeRecord(stored) || stored.pub !== pub) return emptyRecoveryNudgeRecord(pub);
  const { keyInHandAt, firstValueAt, firstValueKind, snoozedUntil, dismissedAt } = stored;
  return { v: 1, pub, keyInHandAt, firstValueAt, firstValueKind, snoozedUntil, dismissedAt };
}

/**
 * Normalise a caller clock to a stamp the guard accepts on reload. Date.now()
 * is the only production caller; a fractional or non-finite value (a test
 * clock, performance.now()) floors / clamps to a positive integer rather than
 * producing a record that silently fails the guard next session.
 */
function asStamp(now: number): number {
  return Number.isFinite(now) ? Math.max(1, Math.floor(now)) : 1;
}

/** Has the recovery key ever been revealed or pasted for this identity? */
export function isRecoveryKeyInHand(rec: RecoveryNudgeRecord): boolean {
  return rec.keyInHandAt > 0;
}

/**
 * A value seam fired. Stamps the FIRST accrual only: the moment and the kind
 * are kept from the first call, later kinds never overwrite them (the prompt
 * is about the first moment, not the latest holding). `first` tells the
 * caller whether this call was that moment, so it logs and persists once.
 */
export function noteIdentityValue(
  rec: RecoveryNudgeRecord,
  kind: IdentityValueKind,
  now: number,
): { record: RecoveryNudgeRecord; first: boolean } {
  if (rec.firstValueAt > 0) return { record: rec, first: false };
  return { record: { ...rec, firstValueAt: asStamp(now), firstValueKind: kind }, first: true };
}

/**
 * The recovery key was just SHOWN or PASTED. Monotonic: a clock stepped
 * backwards never rolls the marker back towards "never".
 */
export function noteRecoveryKeyInHand(rec: RecoveryNudgeRecord, now: number): RecoveryNudgeRecord {
  return { ...rec, keyInHandAt: Math.max(rec.keyInHandAt, asStamp(now)) };
}

/** LATER: silence the banner for RECOVERY_NUDGE_SNOOZE_MS. */
export function snoozeRecoveryNudge(rec: RecoveryNudgeRecord, now: number): RecoveryNudgeRecord {
  return { ...rec, snoozedUntil: asStamp(now) + RECOVERY_NUDGE_SNOOZE_MS };
}

/**
 * DON'T ASK AGAIN: the banner never returns for this identity. The identity
 * row's "NO BACKUP" cue is unaffected — it states a fact, it does not nag.
 */
export function dismissRecoveryNudge(rec: RecoveryNudgeRecord, now: number): RecoveryNudgeRecord {
  return { ...rec, dismissedAt: asStamp(now) };
}

/**
 * Should the banner be armed right now? Precedence, most final first:
 *   key in hand → nothing to nudge about (for this identity);
 *   no value yet → too early (the whole point is not to nag before then);
 *   dismissed   → the player's standing answer;
 *   snoozed     → until `snoozedUntil` (shows again AT that instant);
 *   otherwise   → show, with the kind that accrued first for the copy.
 */
export function decideRecoveryNudge(rec: RecoveryNudgeRecord, now: number): RecoveryNudgeVerdict {
  if (isRecoveryKeyInHand(rec)) return { show: false, reason: 'key-in-hand' };
  if (rec.firstValueAt <= 0) return { show: false, reason: 'no-value' };
  if (rec.dismissedAt > 0) return { show: false, reason: 'dismissed' };
  if (rec.snoozedUntil > now) return { show: false, reason: 'snoozed' };
  return { show: true, kind: rec.firstValueKind };
}

// ── Storage adapter ──────────────────────────────────────────────────────────

/** The two Storage methods used — `localStorage` satisfies it, so does a Map shim. */
export interface RecoveryNudgeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the live identity's record. `store` may be null (privacy mode, where
 * even touching localStorage throws — main.ts resolves it under try/catch);
 * any read or parse failure reads as "never", so a broken store re-arms the
 * nudge rather than silencing it, and nothing here throws into the caller.
 */
export function loadRecoveryNudgeRecord(store: RecoveryNudgeStore | null, pub: string): RecoveryNudgeRecord {
  if (!store) return emptyRecoveryNudgeRecord(pub);
  try {
    const raw = store.getItem(RECOVERY_NUDGE_STORAGE_KEY);
    return recoveryNudgeRecordFor(raw === null ? null : JSON.parse(raw), pub);
  } catch {
    return emptyRecoveryNudgeRecord(pub);
  }
}

/** Persist; false when the store is absent or throws (quota, privacy mode). */
export function saveRecoveryNudgeRecord(store: RecoveryNudgeStore | null, rec: RecoveryNudgeRecord): boolean {
  if (!store) return false;
  try {
    store.setItem(RECOVERY_NUDGE_STORAGE_KEY, JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}
