// treasuryNetwork.ts — which Chia network this build's treasury cache trusts.
//
// Plan §17.5: every treasury record binds the configured genesis challenge and
// the cache (treasuryDoc's pin) rejects records from any other network, so a
// testnet record can never be displayed by a mainnet build or vice versa.
// PR C owns this configuration seam.
//
// The real genesis values are the node's network constants and arrive with the
// node treasury lane (PR D) — they are deliberately NOT hardcoded here, because
// a wrong constant would silently pin a build to a network nobody runs.
//
// An unconfigured build has NO pin at all, not a placeholder one. An earlier
// version used 64 zeros, which looks unusable but is perfectly valid Hex32:
// treasuryDoc accepted it as the active network, so any peer could publish
// records carrying that same all-zero genesis and an unconfigured build would
// render them. Returning null instead lets the caller hand treasuryDoc a value
// it must reject, which closes the cache entirely — nothing matches, so
// nothing shows.

export interface TreasuryNetwork {
  /**
   * The genesis challenge treasuryDoc pins its cache to, or null when this
   * build has no network configured. Callers must NOT substitute a plausible
   * hex value for null: pass something treasuryDoc will refuse.
   */
  genesisChallenge: string | null;
  /** Player-facing network name for the UI's verification line. */
  label: string;
  /** False when this build has no real network configured. */
  configured: boolean;
}

/**
 * What to pin with when unconfigured: deliberately not 64 hex characters, so
 * treasuryDoc's own guard refuses it and disables every treasury read.
 */
export const NO_NETWORK_PIN = 'no-network-configured';

/** The last malformed value warned about, so the warning is not repeated. */
let lastWarnedValue: string | null = null;

/**
 * Reads one configuration value.
 *
 * The import.meta.env accesses below are written out LITERALLY on purpose.
 * Vite substitutes `import.meta.env.VITE_FOO` at build time by matching that
 * exact text; a computed lookup like `env[key]` is not substituted and
 * survives into the bundle as a property read on an object the browser does
 * not have. An earlier version did exactly that, so a production build with
 * the genesis configured would still have reported itself unconfigured and
 * closed every treasury read — the one failure this seam exists to prevent.
 *
 * process.env is kept only as a fallback for node tooling and tests, where
 * Vite's substitution never runs.
 */
function envValue(key: 'VITE_SSF_TREASURY_GENESIS' | 'VITE_SSF_TREASURY_NETWORK'): string {
  let fromMeta: string | undefined;
  try {
    fromMeta =
      key === 'VITE_SSF_TREASURY_GENESIS'
        ? import.meta.env.VITE_SSF_TREASURY_GENESIS
        : import.meta.env.VITE_SSF_TREASURY_NETWORK;
  } catch {
    /* import.meta.env is absent outside Vite */
  }
  if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) {
    return fromMeta.trim();
  }
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process;
    return (proc?.env?.[key] ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Release/operator configuration, per the plan's network-separation rule:
 * `VITE_SSF_TREASURY_GENESIS` (64 lowercase hex) plus an optional
 * `VITE_SSF_TREASURY_NETWORK` label. A malformed value is refused rather than
 * guessed at — the build stays unconfigured, which closes the cache, and says
 * so. There is no placeholder pin: see the note above on why a plausible one
 * would be worse than none.
 */
export function treasuryNetwork(): TreasuryNetwork {
  const raw = envValue('VITE_SSF_TREASURY_GENESIS').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(raw)) {
    const label = envValue('VITE_SSF_TREASURY_NETWORK');
    return {
      genesisChallenge: raw,
      label: label.length > 0 ? label : 'configured network',
      configured: true,
    };
  }
  // Warn once per distinct bad value: this is called from the room
  // terminal's refresh loop, so warning every time would turn one bad
  // deployment setting into a console flood.
  if (raw.length > 0 && raw !== lastWarnedValue) {
    lastWarnedValue = raw;
    console.warn('treasuryNetwork: VITE_SSF_TREASURY_GENESIS is not 64 lowercase hex — treasury records will not be shown');
  }
  return {
    genesisChallenge: null,
    label: 'not configured',
    configured: false,
  };
}
