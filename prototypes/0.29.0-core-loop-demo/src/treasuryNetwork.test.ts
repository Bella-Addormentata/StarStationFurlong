// treasuryNetwork tests: the pin must FAIL CLOSED. An unconfigured build has
// no network, not a placeholder one — a plausible-looking placeholder is still
// a valid pin, and any peer could publish records carrying it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_NETWORK_PIN, treasuryNetwork } from './treasuryNetwork';

const GENESIS = 'ae83525ba8d1dd3f09b277de18ca3e43fc0af20d20c4b3e92ef2a48bd291ccb2';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('configured builds', () => {
  it('accepts 64 lowercase hex and carries the label through', () => {
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', GENESIS);
    vi.stubEnv('VITE_SSF_TREASURY_NETWORK', 'testnet');
    const net = treasuryNetwork();
    expect(net.configured).toBe(true);
    expect(net.genesisChallenge).toBe(GENESIS);
    expect(net.label).toBe('testnet');
  });

  it('accepts an uppercase value by normalising it, since Hex32 is lowercase', () => {
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', GENESIS.toUpperCase());
    const net = treasuryNetwork();
    expect(net.configured).toBe(true);
    expect(net.genesisChallenge).toBe(GENESIS);
  });

  it('falls back to a generic label when none is given', () => {
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', GENESIS);
    expect(treasuryNetwork().label).toBe('configured network');
  });
});

describe('unconfigured builds fail closed', () => {
  const expectClosed = (net: ReturnType<typeof treasuryNetwork>) => {
    expect(net.configured).toBe(false);
    // null, never a plausible hex string: the caller substitutes a pin that
    // treasuryDoc must refuse, which disables every treasury read.
    expect(net.genesisChallenge).toBeNull();
  };

  it('reports no network when the variable is missing or blank', () => {
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', '');
    expectClosed(treasuryNetwork());
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', '   ');
    expectClosed(treasuryNetwork());
  });

  it('refuses malformed values instead of guessing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [
      'not-hex',
      GENESIS.slice(0, 63),
      `${GENESIS}ab`,
      `${GENESIS.slice(0, 62)}zz`,
      '0x' + GENESIS.slice(2),
    ]) {
      vi.stubEnv('VITE_SSF_TREASURY_GENESIS', bad);
      expectClosed(treasuryNetwork());
    }
    expect(warn).toHaveBeenCalled();
  });

  it('treats an all-zero genesis as a real pin only if someone configures it', () => {
    // 64 zeros is valid Hex32, which is exactly why it must never be the
    // DEFAULT: as a default it becomes the live network and any peer can
    // publish records under it. Explicitly configured, it is the operator's
    // choice and is honoured.
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', '0'.repeat(64));
    const net = treasuryNetwork();
    expect(net.configured).toBe(true);
    expect(net.genesisChallenge).toBe('0'.repeat(64));
    // …but with nothing configured, the default is not that value.
    vi.stubEnv('VITE_SSF_TREASURY_GENESIS', '');
    expect(treasuryNetwork().genesisChallenge).not.toBe('0'.repeat(64));
  });

  it('offers a substitute pin that cannot be a genesis challenge', () => {
    // What main.ts passes in place of null. treasuryDoc validates the pin as
    // 64 lowercase hex, so this must not be that.
    expect(NO_NETWORK_PIN).not.toMatch(/^[0-9a-f]{64}$/);
    expect(NO_NETWORK_PIN.length).toBeGreaterThan(0);
  });
});
