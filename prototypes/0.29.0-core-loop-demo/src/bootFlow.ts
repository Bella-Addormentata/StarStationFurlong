/**
 * 🛰️ Boot-flow pure logic (#79 P5).
 *
 * The install-boot decision was previously braided through main.ts's
 * bootstrapNetworking(): the priority ordering (override → last-room resume →
 * per-identity clone-vat preference → shared station → per-install home) was
 * only exercised end-to-end by running the whole app. That priority is the
 * OWNER-SPEC contract from issue #79 ("all new players spawn in the same vat
 * in the same station" while "existing users… fade to current location's
 * atlas from when they last shut down"), so it deserves a tested seam.
 *
 * The boot-title state machine that Load-from-Backup drives (idle → paste →
 * confirm → applied) is the second untested seam: the owner-spec confirmation
 * step ("text box to paste key, then confirmation then load atlas") only
 * makes sense as an atomic sequence of state transitions, and we want to
 * PROVE that a bad paste cannot silently corrupt the current identity and
 * that Cancel cleanly returns to paste.
 *
 * This module holds ONLY pure functions (no DOM, no localStorage, no clock).
 * main.ts wires the impure adapters (localStorage getters, `importRecoveryKey`
 * from keypair.ts, `sharedStationBootstrap` from station.ts) into these
 * decisions; vitest exercises the decisions directly. No new runtime
 * behaviour lives here — it is a refactor + test surface only.
 */

// ─── Boot-target selection ───────────────────────────────────────────────────

/**
 * The five sources a boot can resolve to, in strict priority order (later
 * entries only apply when every earlier one is absent):
 *
 *   1. `override`         — an explicit ?seed= URL / Use-link import (deep
 *                            link into someone else's room). Always wins.
 *   2. `last-room`        — `ssf-last-room` persisted from a previous shutdown
 *                            (P4 resume). Skipped when an override is present.
 *   3. `clone-preference` — per-identity clone-vat preference for the CURRENT
 *                            identity (P2), keyed to the identity pubkey. Only
 *                            applies when it names a NON-station room (a
 *                            station-pointing preference is silently ignored;
 *                            the shared-station default catches that case
 *                            without dragging its ephemeral wtUrl through the
 *                            preference record).
 *   4. `shared-station`   — the baked-in station id + key from station.ts
 *                            (P3). This is the "every new install lands here"
 *                            default the owner spec calls for.
 *   5. `per-install-home` — the fallback `home-*` from identity.ts, kept as
 *                            the LAST resort so a station-unconfigured build
 *                            still boots into a valid room.
 */
export type BootTargetSource =
  | 'override'
  | 'last-room'
  | 'clone-preference'
  | 'shared-station'
  | 'per-install-home';

/** The minimum room descriptor the boot needs to reach a target. */
export interface BootRoomKey {
  roomId: string;
  roomKeyB64: string;
}

/** The chosen target, tagged with WHICH source produced it (for logging /
 *  UI hints, and so the caller can behave differently on a resume vs a
 *  first-run first entry). */
export interface BootTarget {
  source: BootTargetSource;
  room: BootRoomKey;
}

/** Inputs to `decideBootTarget` — every field is a pure value the caller has
 *  already resolved from its impure source. Optionality mirrors the real
 *  world: overrides are rare, `ssf-last-room` may be absent on a fresh
 *  install, the clone-vat preference is per-identity, the shared station may
 *  be unconfigured on very old builds. */
export interface BootTargetInputs {
  /** `?seed=` / Use-link imported boot, when present. */
  override: BootRoomKey | null;
  /** Parsed `ssf-last-room` from localStorage — the previous session's room. */
  lastRoom: BootRoomKey | null;
  /** Per-identity clone-vat preference (P2, keyed to the current pubkey). */
  clonePreference: BootRoomKey | null;
  /** Baked-in shared station descriptor from station.ts, when configured. */
  sharedStation: BootRoomKey | null;
  /** Fallback per-install `home-*` room id (identity.ts getDefaultRoomId).
   *  Its room key is minted on demand, so we only need the id here. */
  perInstallHome: { roomId: string } | null;
  /**
   * True iff `roomId` names the shared station (station.ts's
   * `isSharedStationRoom`). Injected as a callback so this module never
   * imports station.ts — that keeps the decision testable in isolation and
   * lets a re-bake of the station id ship without touching this file.
   */
  isSharedStationRoom: (roomId: string) => boolean;
  /**
   * Getter for the per-install home's roomKey (identity.ts
   * `getOrCreateRoomKeyB64` in production). Only called when the fallback
   * source actually wins, so a station-configured boot never triggers a
   * mint side-effect in identity.ts. Injected for the same testability
   * reason as `isSharedStationRoom`.
   */
  getPerInstallHomeKey: (roomId: string) => string;
}

/**
 * Resolve the boot target in strict priority order. Returns null ONLY when
 * every source is absent — a build with no override, no resume, no clone-vat
 * preference, no shared station AND no per-install home. In production
 * identity.ts always supplies a home fallback, so `null` is essentially a
 * "boot cannot proceed at all" signal for the caller to log + surface.
 *
 * Deliberately does NOT touch localStorage, DOM, or Rust-node fingerprints.
 * The caller (bootstrapNetworking in main.ts) assembles the network-adjacent
 * parts (wtUrl, certHashes, memberHints) AFTER this returns, using the
 * chosen roomId/roomKeyB64 as the anchor.
 */
export function decideBootTarget(
  inputs: BootTargetInputs,
): BootTarget | null {
  // 1. Override — a deep link is a deliberate act; it always wins.
  if (inputs.override) {
    return { source: 'override', room: inputs.override };
  }

  // 2. Last-room resume (P4) — a returning install lands where it left off.
  //    Skipped for the shared-station id (P3) because the station is a
  //    rebuild-from-defaults room; persisting its wtUrl/certHash into
  //    ssf-last-room and replaying it here would fight the live-fingerprint
  //    path in fetchDefaultBootstrap.
  if (inputs.lastRoom && !inputs.isSharedStationRoom(inputs.lastRoom.roomId)) {
    return { source: 'last-room', room: inputs.lastRoom };
  }

  // 3. Per-identity clone-vat preference (P2). A preference that points at
  //    the shared station is silently ignored (the shared-station default at
  //    step 4 lands there anyway, without the preference dragging along an
  //    ephemeral wtUrl/certHash pair from wherever it was last set).
  if (
    inputs.clonePreference &&
    !inputs.isSharedStationRoom(inputs.clonePreference.roomId)
  ) {
    return { source: 'clone-preference', room: inputs.clonePreference };
  }

  // 4. Shared station (P3) — the baked-in "every new install lands here"
  //    default. Only fires when no earlier source claimed the boot.
  if (inputs.sharedStation) {
    return { source: 'shared-station', room: inputs.sharedStation };
  }

  // 5. Per-install home — the last-resort fallback, kept so a station-
  //    unconfigured build still boots into a valid room.
  if (inputs.perInstallHome) {
    const roomId = inputs.perInstallHome.roomId;
    return {
      source: 'per-install-home',
      room: { roomId, roomKeyB64: inputs.getPerInstallHomeKey(roomId) },
    };
  }

  return null;
}

// ─── Boot-title / Load-from-Backup state machine ─────────────────────────────

/**
 * The distinct stages the boot-title screen walks through on a first-run
 * install (a returning install skips straight to `proceed`). Each stage is a
 * tagged object so its extra data (fingerprint, error) travels with it and
 * the caller can render + transition without out-of-band state.
 *
 *   • `idle`     — NEW PLAYER / LOAD FROM BACKUP buttons visible.
 *   • `paste`    — LOAD FROM BACKUP clicked; paste textarea + PREVIEW button.
 *                  `error` carries the last validation failure (blank on entry).
 *   • `confirm`  — a valid recovery key was pasted; the fingerprint is shown
 *                  and the user must CONFIRM (apply + reload) or CANCEL.
 *   • `applied`  — CONFIRM clicked; the seed is imported and a reload is
 *                  scheduled. Terminal stage; the machine does not tick again.
 *   • `proceed`  — NEW PLAYER clicked (or a returning install skipping the
 *                  choice); the atlas curtain may fade. Terminal stage.
 */
export type BootTitleStage =
  | { kind: 'idle' }
  | { kind: 'paste'; error: string | null }
  | { kind: 'confirm'; fingerprint: string }
  | { kind: 'applied' }
  | { kind: 'proceed' };

/** True iff the stage will never transition again (a fade-anchor for the UI). */
export function isTerminal(stage: BootTitleStage): boolean {
  return stage.kind === 'applied' || stage.kind === 'proceed';
}

/**
 * NEW PLAYER — from any pre-terminal stage, jump straight to `proceed`. The
 * spec allows this at any point before Restore has been CONFIRMED: a user who
 * pasted their key by mistake can back out via NEW PLAYER (the paste box is
 * removed with `wrap.remove()` in the UI layer). Terminal stages are
 * absorbing — `applied` MUST reload the page, so a stray click cannot flip
 * it to `proceed`.
 */
export function chooseNewPlayer(stage: BootTitleStage): BootTitleStage {
  if (isTerminal(stage)) return stage;
  return { kind: 'proceed' };
}

/** LOAD FROM BACKUP — from `idle`, open the paste stage with no error yet. */
export function openPaste(stage: BootTitleStage): BootTitleStage {
  if (stage.kind !== 'idle') return stage;
  return { kind: 'paste', error: null };
}

/**
 * PREVIEW — from `paste`, validate the pasted key. On success, advance to
 * `confirm` carrying the fingerprint the UI shows to the user. On failure,
 * stay in `paste` and stamp the error onto the stage so the UI can render
 * it. The validation itself is injected (previewRecoveryKey from keypair.ts)
 * so this module stays free of the noble/ed25519 dependency.
 */
export function submitPaste(
  stage: BootTitleStage,
  recovery: string,
  preview: (recovery: string) => { pub: string; fingerprint: string } | null,
): BootTitleStage {
  if (stage.kind !== 'paste') return stage;
  const previewed = preview(recovery);
  if (!previewed) {
    return {
      kind: 'paste',
      error: "That isn't a valid recovery key — check it and paste again.",
    };
  }
  return { kind: 'confirm', fingerprint: previewed.fingerprint };
}

/** CANCEL — from `confirm`, go back to a fresh paste stage (error cleared).
 *  The UI clears the textarea in the same handler so the private key never
 *  lingers on-screen after cancel. */
export function cancelConfirm(stage: BootTitleStage): BootTitleStage {
  if (stage.kind !== 'confirm') return stage;
  return { kind: 'paste', error: null };
}

/**
 * CONFIRM — from `confirm`, apply the recovery key (the injected `apply`
 * runs importRecoveryKey + scrubs the textarea + drops ssf-last-room) and
 * advance to `applied`. The caller must schedule the page reload itself; the
 * pure machine only records that the transition happened. If `apply` returns
 * false (the key became invalid between preview and confirm — theoretically
 * impossible, but we guard anyway), the machine snaps back to `paste` with a
 * stamped error rather than silently swallowing the click.
 */
export function confirmRestore(
  stage: BootTitleStage,
  apply: () => boolean,
): BootTitleStage {
  if (stage.kind !== 'confirm') return stage;
  const ok = apply();
  if (!ok) {
    return {
      kind: 'paste',
      error: 'Restore failed — the pasted key was rejected. Try again.',
    };
  }
  return { kind: 'applied' };
}

/**
 * Composite "should the curtain fade now?" gate used by main.ts's
 * setupClickToEnter: the fade is armed when all three underlying conditions
 * (title dwell, exterior view ready, user has chosen to proceed) are true.
 * Extracted so the composite condition can be tested without a browser — the
 * DOM handlers just flip the individual bools and re-check.
 *
 * `proceedChosen` is a bool (not a stage kind) because the composite gate
 * also handles the auto-proceed path for a returning install, where the
 * state machine never starts.
 */
export function readyToFade(inputs: {
  dwellDone: boolean;
  exteriorReady: boolean;
  proceedChosen: boolean;
  alreadyFaded: boolean;
}): boolean {
  return (
    !inputs.alreadyFaded &&
    inputs.dwellDone &&
    inputs.exteriorReady &&
    inputs.proceedChosen
  );
}
