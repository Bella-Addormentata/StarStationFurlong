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

function envValue(key: string): string {
  // Vite's import.meta.env in the browser; process.env under node tooling and
  // tests. Both are read because the key is dynamic, so Vite's static
  // replacement of import.meta.env.FOO does not apply.
  try {
    const meta = (import.meta as { env?: Record<string, string | undefined> }).env;
    const fromMeta = meta?.[key];
    if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) {
      return fromMeta.trim();
    }
  } catch {
    /* import.meta.env is absent in some runtimes */
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
 * guessed at — the build stays on the placeholder and says so.
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
  if (raw.length > 0) {
    console.warn('treasuryNetwork: VITE_SSF_TREASURY_GENESIS is not 64 lowercase hex — treasury records will not be shown');
  }
  return {
    genesisChallenge: null,
    label: 'not configured',
    configured: false,
  };
}
