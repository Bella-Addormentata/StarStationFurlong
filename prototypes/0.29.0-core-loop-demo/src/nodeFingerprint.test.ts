/**
 * The node's fingerprint answer, checked against its contract: 32 bytes of
 * hex, the same 32 bytes in base64, a port — or it is not the node.
 */
import { describe, expect, it } from 'vitest';
import { parseNodeFingerprint } from './nodeFingerprint';

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
