/**
 * The node's fingerprint answer, checked against its contract: 32 bytes of
 * hex, the same 32 bytes in base64, a port — or it is not the node.
 */
import { describe, expect, it } from 'vitest';
import { isTestnetAddress, parseChiaPresence, parseChiaWallet, parseNodeFingerprint } from './nodeFingerprint';

const BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const HEX = [...BYTES].map((b) => b.toString(16).padStart(2, '0')).join('');
const B64 = btoa(String.fromCharCode(...BYTES));

describe('parseNodeFingerprint', () => {
  it('takes the node\'s own answer, normalising what is optional', () => {
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })).toEqual({ hex: HEX, base64: B64, port: 4443 });
    expect(parseNodeFingerprint({
      hex: HEX.toUpperCase(), base64: B64, port: 4443, iroh_node_id: 'abc', iroh_relay_urls: ['https://r', 7, ''],
      iroh_direct_addrs: 'nope', reachability: 'cgnat', iroh_port: 11204,
    })).toEqual({
      hex: HEX, base64: B64, port: 4443, iroh_node_id: 'abc', iroh_relay_urls: ['https://r'], reachability: 'cgnat', iroh_port: 11204,
    });
    // #231 P6b: the node's card-sharing flag rides when it is a boolean, and only then.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, share_card: false })).toEqual({ hex: HEX, base64: B64, port: 4443, share_card: false });
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, share_card: 'no' })?.share_card).toBeUndefined();
  });

  it('keeps the node\'s receive address only in the shape of a testnet11 address (🏦 Bank app RECEIVE)', () => {
    // 58 bech32 characters after `txch1`: 52 for the 32-byte puzzle hash, 6 of checksum.
    const addr = 'txch1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
    expect(isTestnetAddress(addr)).toBe(true);
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_address: addr })?.chia_address).toBe(addr);
    // A read-only node sends none; an older node sends none: nothing is invented.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.chia_address).toBeUndefined();
    // Not an address: a mainnet prefix (real XCH would go to it), a bech32 character
    // outside the set, a length that is not a standard puzzle's, or not a string.
    for (const bad of ['xch1' + addr.slice(5), addr.slice(0, -1) + 'b', addr.slice(0, -1), addr + 'q', addr.toUpperCase(), 42, null, '']) {
      expect(isTestnetAddress(bad)).toBe(false);
      expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_address: bad })?.chia_address).toBeUndefined();
    }
  });

  it('keeps the node\'s SSF wallet switch only in the node\'s own shape (🏦 Bank app)', () => {
    const fp = (chia_wallet: unknown) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_wallet })?.chia_wallet;
    expect(fp({ state: 'ready' })).toEqual({ state: 'ready' });
    expect(fp({ state: 'ready', seed: true })).toEqual({ state: 'ready', seed: true });
    expect(fp({ state: 'on', stays: true, held: false, error: 'disk full' })).toEqual({ state: 'on', stays: true, error: 'disk full' });
    for (const state of ['unbuilt', 'off', 'ready', 'on']) expect(parseChiaWallet({ state })?.state).toBe(state);
    // An older node sends none, and nothing is invented for it.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.chia_wallet).toBeUndefined();
    // Anything off the node's shape is no readout: the Bank then offers no switch.
    for (const bad of [null, 'on', 7, {}, { state: 'ON' }, { state: 'creating' }, { state: 'on', stays: 'yes' }, { state: 'ready', seed: 1 }, { state: 'on', error: 5 }]) {
      expect(fp(bad)).toBeUndefined();
    }
    expect(fp({ state: 'ready', error: '' })).toEqual({ state: 'ready' });
  });

  it('keeps the node\'s Phone Book readout only in the node\'s own shape (📖 top bar icon)', () => {
    const listed = { state: 'listed', era: 7, listed_era: 7, last_at: 1_700_000_000, confirmed: true, current: true, public_addrs: 2 };
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_presence: listed })?.chia_presence).toEqual(listed);
    const failing = { ...listed, state: 'unlisted', listed_era: 0, last_at: 0, confirmed: false, current: false, error: 'chia wallet unfunded' };
    expect(parseChiaPresence(failing)).toEqual(failing);
    // A node that does not publish presence sends none; an older node sends none.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.chia_presence).toBeUndefined();
    // Not the node's shape: an unknown state, a count that is negative, fractional or
    // a string, a flag that is not a boolean, an error that is not a string, or no object.
    for (const bad of [
      { ...listed, state: 'green' }, { ...listed, state: 7 }, { ...listed, era: -1 }, { ...listed, last_at: 1.5 },
      { ...listed, public_addrs: '2' }, { ...listed, confirmed: 'yes' }, { ...listed, current: undefined },
      { ...listed, error: 42 }, 'listed', null, 7, [],
    ]) {
      expect(parseChiaPresence(bad)).toBeUndefined();
      expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_presence: bad })?.chia_presence).toBeUndefined();
    }
    // Extra keys from a newer node are not carried along.
    expect(parseChiaPresence({ ...listed, writes: 3 })).toEqual(listed);
  });

  it('refuses what is not a fingerprint: a stranger on the port, or a shape that merely passes a truthiness check', () => {
    expect(parseNodeFingerprint({})).toBeNull();
    expect(parseNodeFingerprint(null)).toBeNull();
    expect(parseNodeFingerprint('ok')).toBeNull();
    expect(parseNodeFingerprint({ hex: true, base64: B64, port: 4443 })).toBeNull();
    expect(parseNodeFingerprint({ hex: 'abc', base64: B64, port: 4443 })).toBeNull();
    expect(parseNodeFingerprint({ hex: HEX, base64: 'not base64 at all', port: 4443 })).toBeNull();
    expect(parseNodeFingerprint({ hex: HEX, base64: btoa('short'), port: 4443 })).toBeNull();
    // 32 bytes of hex and 32 bytes of base64 that are not the SAME bytes.
    const other = btoa(String.fromCharCode(...BYTES.map((b) => b ^ 1)));
    expect(parseNodeFingerprint({ hex: HEX, base64: other, port: 4443 })).toBeNull();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 0 })).toBeNull();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 70000 })).toBeNull();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: '4443' })).toBeNull();
  });
});

describe('the blob lane token', () => {
  it('rides as 64 hex digits, and only so', () => {
    const cap = 'ab'.repeat(32);
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, blob_cap: cap })?.blob_cap).toBe(cap);
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, blob_cap: 'AB'.repeat(32) })?.blob_cap).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, blob_cap: 'ab' })?.blob_cap).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, blob_cap: 7 })?.blob_cap).toBeUndefined();
  });
});

describe('the torrent lane flag', () => {
  it('is set only by a literal true', () => {
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, torrent: true })?.torrent).toBe(true);
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, torrent: 'yes' })?.torrent).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.torrent).toBeUndefined();
  });
});

describe('the house key', () => {
  it('is kept only as 43 characters of base64url', () => {
    const house = 'A-_z'.repeat(10) + 'abc';
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, house })?.house).toBe(house);
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, house: `${house}=` })?.house).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, house: house.slice(1) })?.house).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, house: 'A+/z'.repeat(10) + 'abc' })?.house).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, house: 43 })?.house).toBeUndefined();
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.house).toBeUndefined();
  });
});
