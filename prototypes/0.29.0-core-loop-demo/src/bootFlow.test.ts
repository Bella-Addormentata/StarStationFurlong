// bootFlow.ts tests (#79 P5): the two pure seams the boot title screen leans on.
//
//   1. decideBootTarget — the priority ordering the owner spec calls for:
//      override → last-room → clone-preference → shared-station → per-install-home.
//      Every rung must be reachable, every skip rule must fire, and a station-
//      pointing preference / last-room MUST fall through to the station default.
//
//   2. Boot-title state machine — the paste → confirm → applied sequence the
//      Load-from-Backup flow drives. Bad pastes cannot corrupt the current
//      identity (apply is only called from `confirm`), Cancel cleanly returns
//      to paste, and terminal stages are absorbing (a stray click after
//      applied cannot re-open the choice).
//
// No DOM, no localStorage, no timers. The impure adapters (previewRecoveryKey,
// importRecoveryKey) are injected as callbacks so the tests are node-only.

import { describe, expect, it } from 'vitest';
import {
  cancelConfirm,
  chooseNewPlayer,
  confirmRestore,
  decideBootTarget,
  decideInitialStage,
  isTerminal,
  openPaste,
  readyToFade,
  submitPaste,
  type BootRoomKey,
  type BootTargetInputs,
} from './bootFlow';

// ─── decideBootTarget ────────────────────────────────────────────────────────

/** Baseline inputs — every source ABSENT except an isSharedStationRoom guard
 *  that matches the literal 'station-alpha' (a stand-in for whatever station.ts
 *  actually configures, so a re-bake never breaks these tests). */
const STATION_ID = 'station-alpha';
function baseInputs(): BootTargetInputs {
  return {
    override: null,
    lastRoom: null,
    clonePreference: null,
    sharedStation: null,
    perInstallHome: null,
    isSharedStationRoom: (roomId) => roomId === STATION_ID,
    // Track how many times the fallback key mint is triggered.
    getPerInstallHomeKey: () => 'HOME-KEY',
  };
}

const OVERRIDE: BootRoomKey = { roomId: 'invited-room', roomKeyB64: 'k-invite' };
const LAST_ROOM: BootRoomKey = { roomId: 'last-room', roomKeyB64: 'k-last' };
const CLONE_PREF: BootRoomKey = { roomId: 'clone-vat', roomKeyB64: 'k-clone' };
const SHARED_STATION: BootRoomKey = { roomId: STATION_ID, roomKeyB64: 'k-station' };
const HOME = { roomId: 'home-1234abcd' };

describe('bootFlow.decideBootTarget — priority order', () => {
  it('override wins over every other source', () => {
    const target = decideBootTarget({
      ...baseInputs(),
      override: OVERRIDE,
      lastRoom: LAST_ROOM,
      clonePreference: CLONE_PREF,
      sharedStation: SHARED_STATION,
      perInstallHome: HOME,
    });
    expect(target).toEqual({ source: 'override', room: OVERRIDE });
  });

  it('last-room resumes when there is no override', () => {
    const target = decideBootTarget({
      ...baseInputs(),
      lastRoom: LAST_ROOM,
      clonePreference: CLONE_PREF,
      sharedStation: SHARED_STATION,
      perInstallHome: HOME,
    });
    expect(target).toEqual({ source: 'last-room', room: LAST_ROOM });
  });

  it('last-room targeting the station is IGNORED (falls through to station default)', () => {
    // A station-scoped ssf-last-room would fight the live-fingerprint rebuild —
    // the shared-station rung must catch it without the resume's ephemeral
    // wtUrl/certHash overriding.
    const target = decideBootTarget({
      ...baseInputs(),
      lastRoom: { roomId: STATION_ID, roomKeyB64: 'stale-key' },
      sharedStation: SHARED_STATION,
    });
    expect(target).toEqual({ source: 'shared-station', room: SHARED_STATION });
  });

  it('clone-preference wins over the shared station when it names a NON-station room', () => {
    const target = decideBootTarget({
      ...baseInputs(),
      clonePreference: CLONE_PREF,
      sharedStation: SHARED_STATION,
      perInstallHome: HOME,
    });
    expect(target).toEqual({ source: 'clone-preference', room: CLONE_PREF });
  });

  it('clone-preference pointing at the station is IGNORED (falls through to station default)', () => {
    // A station-targeting preference is meaningless — the station default at
    // step 4 catches it without dragging along the preference's own key
    // record (which is the whole reason the P3 write-side skips the station).
    const target = decideBootTarget({
      ...baseInputs(),
      clonePreference: { roomId: STATION_ID, roomKeyB64: 'ignored' },
      sharedStation: SHARED_STATION,
    });
    expect(target).toEqual({ source: 'shared-station', room: SHARED_STATION });
  });

  it('shared-station fires when nothing above claims the boot', () => {
    const target = decideBootTarget({
      ...baseInputs(),
      sharedStation: SHARED_STATION,
      perInstallHome: HOME,
    });
    expect(target).toEqual({ source: 'shared-station', room: SHARED_STATION });
  });

  it('per-install-home is the LAST RESORT (station unconfigured)', () => {
    // Station-unconfigured builds still boot into a valid room via the
    // identity.ts fallback. The key mint is only triggered by THIS branch.
    let mintedFor: string | null = null;
    const target = decideBootTarget({
      ...baseInputs(),
      perInstallHome: HOME,
      getPerInstallHomeKey: (roomId) => {
        mintedFor = roomId;
        return 'MINTED-HOME-KEY';
      },
    });
    expect(target).toEqual({
      source: 'per-install-home',
      room: { roomId: HOME.roomId, roomKeyB64: 'MINTED-HOME-KEY' },
    });
    expect(mintedFor).toBe(HOME.roomId);
  });

  it('returns null when every source is absent (a boot cannot proceed)', () => {
    // A pathological config with no station AND no per-install home. In
    // production identity.ts always supplies HOME, so this asserts the
    // signalling contract for the diagnostic path in main.ts.
    expect(decideBootTarget(baseInputs())).toBeNull();
  });

  it('does NOT mint a per-install home key when a higher priority source wins', () => {
    // Guard against a subtle regression: an early implementation computed
    // the fallback key eagerly, which would trigger identity.ts's random-key
    // mint on the happy path (P3 default). The lazy call means station-
    // configured boots never touch the home-key mint.
    let calls = 0;
    decideBootTarget({
      ...baseInputs(),
      sharedStation: SHARED_STATION,
      perInstallHome: HOME,
      getPerInstallHomeKey: (roomId) => { calls++; return `k-${roomId}`; },
    });
    expect(calls).toBe(0);
  });
});

// ─── Boot-title state machine ────────────────────────────────────────────────

describe('bootFlow — boot-title state machine (NEW PLAYER / LOAD FROM BACKUP)', () => {
  it('chooseNewPlayer promotes any pre-terminal stage to proceed', () => {
    expect(chooseNewPlayer({ kind: 'idle' })).toEqual({ kind: 'proceed' });
    expect(chooseNewPlayer({ kind: 'paste', error: null })).toEqual({
      kind: 'proceed',
    });
    expect(chooseNewPlayer({ kind: 'confirm', fingerprint: 'aa' })).toEqual({
      kind: 'proceed',
    });
  });

  it('chooseNewPlayer is a NO-OP on terminal stages (applied cannot flip to proceed)', () => {
    // applied MUST reload the page; a stray click after must never re-open.
    expect(chooseNewPlayer({ kind: 'applied' })).toEqual({ kind: 'applied' });
    // proceed is already terminal — the second choice is a no-op too.
    expect(chooseNewPlayer({ kind: 'proceed' })).toEqual({ kind: 'proceed' });
  });

  it('openPaste opens the paste stage from idle only', () => {
    expect(openPaste({ kind: 'idle' })).toEqual({ kind: 'paste', error: null });
    // Any other stage is a no-op — the button is gone from the DOM by then.
    const paste = { kind: 'paste', error: null } as const;
    expect(openPaste(paste)).toBe(paste);
    const applied = { kind: 'applied' } as const;
    expect(openPaste(applied)).toBe(applied);
  });

  it('submitPaste advances to confirm on a valid key (preview succeeds)', () => {
    // The impure preview is INJECTED — a fake succeeds on 'good' and fails
    // on anything else. The fingerprint travels with the stage so the UI
    // can render it without a second call.
    const preview = (r: string) =>
      r.trim() === 'good' ? { pub: 'PPP', fingerprint: '01020304' } : null;
    const paste = { kind: 'paste', error: null } as const;
    expect(submitPaste(paste, 'good', preview)).toEqual({
      kind: 'confirm',
      fingerprint: '01020304',
    });
  });

  it('submitPaste STAYS in paste with a stamped error on a bad key', () => {
    const preview = () => null;
    const paste = { kind: 'paste', error: null } as const;
    const next = submitPaste(paste, 'garbage', preview);
    expect(next.kind).toBe('paste');
    // The error text is a user-facing note — assert only the SHAPE (non-empty
    // string) so wording tweaks don't destabilise the test.
    if (next.kind === 'paste') {
      expect(typeof next.error).toBe('string');
      expect(next.error!.length).toBeGreaterThan(0);
    }
  });

  it('submitPaste is a no-op outside the paste stage (defensive)', () => {
    // A stray click after the state advanced must not re-invoke preview.
    let called = 0;
    const preview = () => { called++; return null; };
    submitPaste({ kind: 'idle' }, 'x', preview);
    submitPaste({ kind: 'confirm', fingerprint: 'aa' }, 'x', preview);
    submitPaste({ kind: 'applied' }, 'x', preview);
    submitPaste({ kind: 'proceed' }, 'x', preview);
    expect(called).toBe(0);
  });

  it('cancelConfirm returns to paste with a cleared error', () => {
    expect(
      cancelConfirm({ kind: 'confirm', fingerprint: 'deadbeef' }),
    ).toEqual({ kind: 'paste', error: null });
  });

  it('cancelConfirm is a no-op outside confirm', () => {
    expect(cancelConfirm({ kind: 'idle' })).toEqual({ kind: 'idle' });
    const paste = { kind: 'paste', error: null } as const;
    expect(cancelConfirm(paste)).toBe(paste);
    expect(cancelConfirm({ kind: 'applied' })).toEqual({ kind: 'applied' });
  });

  it('confirmRestore invokes apply exactly once and advances to applied on success', () => {
    let calls = 0;
    const apply = () => { calls++; return true; };
    const next = confirmRestore(
      { kind: 'confirm', fingerprint: 'aa' },
      apply,
    );
    expect(next).toEqual({ kind: 'applied' });
    expect(calls).toBe(1);
  });

  it('confirmRestore snaps back to paste with an error on apply-false', () => {
    // Belt-and-braces: if the key became invalid between preview and
    // confirm (theoretically impossible), we surface it instead of stalling.
    const apply = () => false;
    const next = confirmRestore(
      { kind: 'confirm', fingerprint: 'aa' },
      apply,
    );
    expect(next.kind).toBe('paste');
    if (next.kind === 'paste') expect(next.error).not.toBeNull();
  });

  it('confirmRestore is a no-op outside confirm — apply is never called elsewhere', () => {
    // The MOST important invariant: importRecoveryKey MUST NOT be called
    // from paste, idle, applied, or proceed. This is the guarantee that
    // rules out a stray click corrupting the current identity.
    let calls = 0;
    const apply = () => { calls++; return true; };
    confirmRestore({ kind: 'idle' }, apply);
    confirmRestore({ kind: 'paste', error: null }, apply);
    confirmRestore({ kind: 'applied' }, apply);
    confirmRestore({ kind: 'proceed' }, apply);
    expect(calls).toBe(0);
  });

  it('isTerminal flags exactly the two terminal stages', () => {
    expect(isTerminal({ kind: 'idle' })).toBe(false);
    expect(isTerminal({ kind: 'paste', error: null })).toBe(false);
    expect(isTerminal({ kind: 'confirm', fingerprint: 'aa' })).toBe(false);
    expect(isTerminal({ kind: 'applied' })).toBe(true);
    expect(isTerminal({ kind: 'proceed' })).toBe(true);
  });
});

// ─── decideInitialStage — first-run vs returning-install boot order ─────────

describe('bootFlow.decideInitialStage — first-run vs returning boot order (#79 P6)', () => {
  it('returns idle on a first-run install (no stored identity)', () => {
    // The title screen MUST show NEW PLAYER + LOAD FROM BACKUP before any
    // atlas view — the owner's boot-order rule. `idle` is the non-terminal
    // stage so the curtain does not fade before a choice is made.
    const stage = decideInitialStage(false);
    expect(stage).toEqual({ kind: 'idle' });
    expect(isTerminal(stage)).toBe(false);
  });

  it('returns proceed on a returning install (identity on disk)', () => {
    // Existing users boot straight to their last location — the title screen
    // still flashes for the dwell, but the fade is armed the moment exterior
    // is ready (readyToFade sees proceedChosen=true immediately).
    const stage = decideInitialStage(true);
    expect(stage).toEqual({ kind: 'proceed' });
    expect(isTerminal(stage)).toBe(true);
  });

  it('is a pure function of the single bool (no side effects, no hidden state)', () => {
    // Same input → same output, indefinitely. The guarantee that lets main.ts
    // call this once at wire-up time without worrying about racing anything.
    for (let i = 0; i < 4; i++) {
      expect(decideInitialStage(false)).toEqual({ kind: 'idle' });
      expect(decideInitialStage(true)).toEqual({ kind: 'proceed' });
    }
  });

  it('threads into readyToFade — a returning install fades once the room is ready', () => {
    // Composed with readyToFade: proceedChosen is derived from the initial
    // stage kind, so a returning install arms the curtain gate immediately.
    const stage = decideInitialStage(true);
    const proceedChosen = stage.kind === 'proceed';
    expect(
      readyToFade({
        dwellDone: true,
        exteriorReady: true,
        proceedChosen,
        alreadyFaded: false,
      }),
    ).toBe(true);
  });

  it('threads into readyToFade — a first-run install BLOCKS the curtain until a choice', () => {
    // Symmetry: `idle` never sets proceedChosen, so the gate stays closed —
    // the atlas is not shown until NEW PLAYER (or CONFIRM after restore)
    // promotes the stage to a terminal one.
    const stage = decideInitialStage(false);
    // Same derivation main.ts uses (stage.kind === 'proceed') — for idle it's
    // false, so the composite gate refuses to fire.
    const proceedChosen: boolean = stage.kind === 'proceed';
    expect(
      readyToFade({
        dwellDone: true,
        exteriorReady: true,
        proceedChosen,
        alreadyFaded: false,
      }),
    ).toBe(false);
  });
});

// ─── readyToFade — composite curtain gate ────────────────────────────────────

describe('bootFlow.readyToFade — curtain gate', () => {
  it('is true only when all three conditions are met AND not already faded', () => {
    expect(
      readyToFade({
        dwellDone: true,
        exteriorReady: true,
        proceedChosen: true,
        alreadyFaded: false,
      }),
    ).toBe(true);
  });

  it('never re-fires once faded (alreadyFaded absorbs the gate)', () => {
    expect(
      readyToFade({
        dwellDone: true,
        exteriorReady: true,
        proceedChosen: true,
        alreadyFaded: true,
      }),
    ).toBe(false);
  });

  it('requires each condition individually', () => {
    const base = {
      dwellDone: true,
      exteriorReady: true,
      proceedChosen: true,
      alreadyFaded: false,
    };
    expect(readyToFade({ ...base, dwellDone: false })).toBe(false);
    expect(readyToFade({ ...base, exteriorReady: false })).toBe(false);
    expect(readyToFade({ ...base, proceedChosen: false })).toBe(false);
  });
});
