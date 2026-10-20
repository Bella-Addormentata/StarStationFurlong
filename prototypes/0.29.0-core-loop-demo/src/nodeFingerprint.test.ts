/**
 * The node's fingerprint answer, checked against its contract: 32 bytes of
 * hex, the same 32 bytes in base64, a port — or it is not the node.
 */
import { describe, expect, it } from 'vitest';
import { isTestnetAddress, parseNodeFingerprint } from './nodeFingerprint';

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
