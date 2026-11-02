/**
 * The node's fingerprint answer, checked against its contract: 32 bytes of
 * hex, the same 32 bytes in base64, a port — or it is not the node.
 */
import { describe, expect, it } from 'vitest';
import { MAINNET, TESTNET11, addressOn, isAddressOn } from './chiaNetwork';
import { parseChiaPresence, parseChiaWallet, parseNodeFingerprint } from './nodeFingerprint';

const BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const HEX = [...BYTES].map((b) => b.toString(16).padStart(2, '0')).join('');
const B64 = btoa(String.fromCharCode(...BYTES));

describe('parseNodeFingerprint', () => {
  it('takes the node\'s own answer, normalising what is optional', () => {
    // ⛓️ The network is always resolved: a node that sends none is on testnet11.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })).toEqual({ hex: HEX, base64: B64, port: 4443, chia_net: TESTNET11 });
    expect(parseNodeFingerprint({
      hex: HEX.toUpperCase(), base64: B64, port: 4443, iroh_node_id: 'abc', iroh_relay_urls: ['https://r', 7, ''],
      iroh_direct_addrs: 'nope', reachability: 'cgnat', iroh_port: 11204,
    })).toEqual({
      hex: HEX, base64: B64, port: 4443, chia_net: TESTNET11, iroh_node_id: 'abc', iroh_relay_urls: ['https://r'], reachability: 'cgnat', iroh_port: 11204,
    });
    // #231 P6b: the node's card-sharing flag rides when it is a boolean, and only then.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, share_card: false })).toEqual({ hex: HEX, base64: B64, port: 4443, chia_net: TESTNET11, share_card: false });
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, share_card: 'no' })?.share_card).toBeUndefined();
  });

  it('keeps the node\'s receive address only in the shape of a testnet11 address (🏦 Bank app RECEIVE)', () => {
    // 58 bech32 characters after `txch1`: 52 for the 32-byte puzzle hash, 6 of checksum.
    const addr = 'txch1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
    expect(isAddressOn(TESTNET11, addr)).toBe(true);
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_address: addr })?.chia_address).toBe(addr);
    // A read-only node sends none; an older node sends none: nothing is invented.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.chia_address).toBeUndefined();
    // Not an address: a mainnet prefix (real XCH would go to it), a bech32 character
    // outside the set, a length that is not a standard puzzle's, or not a string.
    for (const bad of ['xch1' + addr.slice(5), addr.slice(0, -1) + 'b', addr.slice(0, -1), addr + 'q', addr.toUpperCase(), 42, null, '']) {
      expect(isAddressOn(TESTNET11, bad)).toBe(false);
      expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_address: bad })?.chia_address).toBeUndefined();
    }
  });

  it('keeps the node\'s SSF wallet switch only in the node\'s own shape (🏦 Bank app)', () => {
    const fp = (chia_wallet: unknown) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_wallet })?.chia_wallet;
    expect(fp({ state: 'ready' })).toEqual({ state: 'ready' });
    expect(fp({ state: 'ready', seed: true })).toEqual({ state: 'ready', seed: true });
    expect(fp({ state: 'on', stays: true, held: false, error: 'disk full' })).toEqual({ state: 'on', stays: true, error: 'disk full' });
    for (const state of ['unbuilt', 'off', 'ready', 'on']) expect(parseChiaWallet({ state })?.state).toBe(state);
    // ⛓️ Mainnet makes SSF wallets now, so `gated` (an older mainnet node's
    // "none here") is no state of the switch: it reads as an older node,
    // which the Bank offers no switch for.
    expect(fp({ state: 'gated' })).toBeUndefined();
    expect(fp({ state: 'gated', backup: 'none' })).toBeUndefined();
    // An older node sends none, and nothing is invented for it.
    expect(parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443 })?.chia_wallet).toBeUndefined();
    // Anything off the node's shape is no readout: the Bank then offers no switch.
    for (const bad of [null, 'on', 7, {}, { state: 'ON' }, { state: 'creating' }, { state: 'on', stays: 'yes' }, { state: 'ready', seed: 1 }, { state: 'on', error: 5 }]) {
      expect(fp(bad)).toBeUndefined();
    }
    expect(fp({ state: 'ready', error: '' })).toEqual({ state: 'ready' });
  });

  it('keeps the 24-word flags when true, drops them when false, and carries nothing else (🏦 BACK UP)', () => {
    const fp = (chia_wallet: unknown) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_wallet })?.chia_wallet;
    expect(fp({ state: 'ready', legacy: true })).toEqual({ state: 'ready', legacy: true });
    expect(fp({ state: 'on', stays: true, mnemonic: true, reminted: true })).toEqual({ state: 'on', stays: true, mnemonic: true, reminted: true });
    expect(fp({ state: 'on', stays: true, mnemonic: true, backed_up: true })).toEqual({ state: 'on', stays: true, mnemonic: true, backed_up: true });
    expect(fp({ state: 'on', seed: false, legacy: false, mnemonic: false, backed_up: false, reminted: false })).toEqual({ state: 'on' });
    // A flag that is not a boolean is no readout at all, whatever it holds.
    for (const flag of ['legacy', 'mnemonic', 'backed_up', 'reminted']) {
      for (const bad of [['a'], 'true', 1, null, { a: 1 }]) expect(fp({ state: 'on', [flag]: bad })).toBeUndefined();
    }
    // Fields the node never sends (words of any name, a key number) do not survive the parse.
    const sample = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
    const parsed = parseNodeFingerprint({
      hex: HEX, base64: B64, port: 4443,
      chia_wallet: { state: 'on', mnemonic: true, words: sample, phrase: sample.join(' '), key: 3552866753, entropy: 'ab'.repeat(32) },
      words: sample, mnemonic: sample.join(' '), phrase: sample.join(' '),
    });
    expect(parsed?.chia_wallet).toEqual({ state: 'on', mnemonic: true });
    const json = JSON.stringify(parsed);
    for (const w of sample) expect(json).not.toContain(w);
    expect(json).not.toContain('3552866753');
  });

  it('keeps how the wallet\'s file is kept at rest, and drops a lock it cannot word (🔒)', () => {
    const fp = (chia_wallet: unknown) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_wallet })?.chia_wallet;
    expect(fp({ state: 'on', mnemonic: true, at_rest: 'none', at_rest_next: 'dpapi' })).toEqual({ state: 'on', mnemonic: true, at_rest: 'none', at_rest_next: 'dpapi' });
    expect(fp({ state: 'on', mnemonic: true, backed_up: true, at_rest: 'dpapi', rewrapped: true })).toEqual({ state: 'on', mnemonic: true, backed_up: true, at_rest: 'dpapi', rewrapped: true });
    // A newer node's lock this page cannot word: that field goes, the switch stays.
    expect(fp({ state: 'on', mnemonic: true, at_rest: 'keychain' })).toEqual({ state: 'on', mnemonic: true });
    // Not a string, or a flag that is not a boolean: no readout at all.
    for (const bad of [1, true, null, ['dpapi'], { kind: 'dpapi' }]) {
      expect(fp({ state: 'on', at_rest: bad })).toBeUndefined();
      expect(fp({ state: 'on', at_rest_next: bad })).toBeUndefined();
    }
    expect(fp({ state: 'on', rewrapped: 'yes' })).toBeUndefined();
  });

  it('keeps who can show the 24 words only as one of the three words, and drops anything else, never the switch (🖥️ backup)', () => {
    const fp = (chia_wallet: unknown) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, chia_wallet })?.chia_wallet;
    for (const backup of ['native', 'page', 'none'] as const) {
      expect(fp({ state: 'on', mnemonic: true, backup })).toEqual({ state: 'on', mnemonic: true, backup });
      expect(parseChiaWallet({ state: 'ready', backup })).toEqual({ state: 'ready', backup });
      // It rides in every state.
      for (const state of ['unbuilt', 'off'] as const) expect(fp({ state, backup })).toEqual({ state, backup });
    }
    // An older node sends none: the switch reads exactly as before the field.
    expect(fp({ state: 'on', mnemonic: true })).toEqual({ state: 'on', mnemonic: true });
    expect('backup' in (fp({ state: 'on', mnemonic: true }) ?? {})).toBe(false);
    // Anything else is dropped as if absent: another word, another case, a
    // padded word, or not a string. The switch stays.
    for (const junk of ['NATIVE', 'Native', ' native', 'shell', 'app', '', 'native,page', 1, 0, true, false, null, ['native'], { kind: 'native' }]) {
      const w = fp({ state: 'on', mnemonic: true, backup: junk });
      expect(w).toEqual({ state: 'on', mnemonic: true });
      expect(parseChiaWallet({ state: 'ready', backup: junk })).toEqual({ state: 'ready' });
    }
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

const BODY = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);

describe.each([TESTNET11, MAINNET])('the node\'s Chia network: $name', (net) => {
  const other = net === TESTNET11 ? MAINNET : TESTNET11;
  const report = { id: net.id, genesis: net.genesis, source: net.test ? 'default' : 'env' };
  const parse = (extra: Record<string, unknown>) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, ...extra });

  it('is the page\'s own row when the id and genesis match', () => {
    expect(parse({ chia_network: report })?.chia_net).toBe(net);
  });

  it('keeps an address on its network, and drops the other network\'s', () => {
    const addr = addressOn(net, BODY);
    expect(parse({ chia_network: report, chia_address: addr })?.chia_address).toBe(addr);
    expect(parse({ chia_network: report, chia_address: addressOn(other, BODY) })?.chia_address).toBeUndefined();
  });

  it('knows no network whose genesis is the other one\'s, and then keeps no address at all', () => {
    const fp = parse({ chia_network: { id: net.id, genesis: other.genesis }, chia_address: addressOn(net, BODY), chia_wallet: { state: 'on' } });
    expect(fp?.chia_net).toBeNull();
    expect(fp?.chia_address).toBeUndefined();
    // The rest of the fingerprint stands: the node is still the node.
    expect(fp?.chia_wallet).toEqual({ state: 'on' });
  });
});

describe('the node\'s Chia network, absent or unknown', () => {
  const parse = (extra: Record<string, unknown>) => parseNodeFingerprint({ hex: HEX, base64: B64, port: 4443, ...extra });

  it('is testnet11 when the node sends none: an xch address is dropped, a txch one kept', () => {
    expect(parse({})?.chia_net).toBe(TESTNET11);
    expect(parse({ chia_address: addressOn(MAINNET, BODY) })?.chia_address).toBeUndefined();
    expect(parse({ chia_address: addressOn(TESTNET11, BODY) })?.chia_address).toBe(addressOn(TESTNET11, BODY));
  });

  it('is null for a network the page does not know, or a report not in the node\'s shape', () => {
    for (const bad of [{ id: 'testnet10', genesis: TESTNET11.genesis }, { id: 'mainnet' }, 'mainnet', null, 7, []]) {
      const fp = parse({ chia_network: bad, chia_address: addressOn(TESTNET11, BODY) });
      expect(fp?.chia_net).toBeNull();
      expect(fp?.chia_address).toBeUndefined();
    }
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
