// treasuryNetwork.ts — which Chia network this build's treasury cache trusts.
//
// Plan §17.5: every treasury record binds the configured genesis challenge and
// the cache (treasuryDoc's pin) rejects records from any other network, so a
// testnet record can never be displayed by a mainnet build or vice versa.
// PR C owns this configuration seam.
//
// The real genesis values are the node's network constants and arrive with the
// node treasury lane (PR D) — they are deliberately NOT hardcoded here, because
// a wrong constant would silently pin a build to a network nobody runs. Until a
// build is configured, the default is a placeholder that matches no real chain:
// an unconfigured build displays nothing rather than something wrong.

/** Matches no real chain — an unconfigured build shows no treasury records. */
const DEV_PLACEHOLDER_GENESIS = '0'.repeat(64);

export interface TreasuryNetwork {
  /** The genesis challenge treasuryDoc pins its cache to. */
  genesisChallenge: string;
  /** Player-facing network name for the UI's verification line. */
  label: string;
  /** False when this build has no real network configured. */
  configured: boolean;
}

function envValue(key: string): string {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return (env?.[key] ?? '').trim();
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
    console.warn('treasuryNetwork: VITE_SSF_TREASURY_GENESIS is not 64 lowercase hex — using the unconfigured placeholder');
  }
  return {
    genesisChallenge: DEV_PLACEHOLDER_GENESIS,
    label: 'not configured',
    configured: false,
  };
}
