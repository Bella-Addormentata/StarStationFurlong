/**
 * ⛓️ The page's two Chia network rows, and how a node's report picks one:
 * only when its id and genesis both match, testnet11 when it says nothing,
 * and no row at all for anything else.
 */
import { describe, expect, it } from 'vitest';
import {
  CHIA_NETWORKS,
  MAINNET,
  MOJOS_PER_COIN,
  TESTNET11,
  addressOn,
  isAddressOn,
  networkOfId,
  parseChiaNetwork,
} from './chiaNetwork';

const BODY = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
const TESTNET11_GENESIS = '37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615';
const MAINNET_GENESIS = 'ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb';

describe('the network rows', () => {
  it('pins both rows to their literal values', () => {
    expect(TESTNET11).toEqual({
      id: 'testnet11', genesis: TESTNET11_GENESIS, prefix: 'txch', ticker: 'TXCH',
      name: 'testnet11', chain: 'the test chain', coins: 'testnet coins', test: true,
    });
    expect(MAINNET).toEqual({
      id: 'mainnet', genesis: MAINNET_GENESIS, prefix: 'xch', ticker: 'XCH',
      name: 'Chia mainnet', chain: 'Chia mainnet', coins: 'mainnet coins', test: false,
    });
    expect(CHIA_NETWORKS).toEqual([TESTNET11, MAINNET]);
    expect(MOJOS_PER_COIN).toBe(1_000_000_000_000n);
    // Fixed: nothing a caller does can change a row.
    expect(Object.isFrozen(TESTNET11) && Object.isFrozen(MAINNET) && Object.isFrozen(CHIA_NETWORKS)).toBe(true);
  });
});

describe('parseChiaNetwork', () => {
  it('reads an absent field as absent, which the page takes as testnet11', () => {
    expect(parseChiaNetwork(undefined)).toBeUndefined();
  });

  it.each(CHIA_NETWORKS.map((n) => [n.id, n] as const))('picks the %s row when the id and genesis both match', (_id, net) => {
    expect(parseChiaNetwork({ id: net.id, genesis: net.genesis, source: 'env' })).toBe(net);
    expect(parseChiaNetwork({ id: net.id, genesis: net.genesis, source: 'default' })).toBe(net);
    // The genesis is hex, whatever its case.
    expect(parseChiaNetwork({ id: net.id, genesis: net.genesis.toUpperCase() })).toBe(net);
  });

  it('knows no network whose genesis does not match its id', () => {
    expect(parseChiaNetwork({ id: 'mainnet', genesis: TESTNET11_GENESIS })).toBeNull();
    expect(parseChiaNetwork({ id: 'testnet11', genesis: MAINNET_GENESIS })).toBeNull();
    expect(parseChiaNetwork({ id: 'mainnet', genesis: MAINNET_GENESIS.slice(0, -1) + '0' })).toBeNull();
    expect(parseChiaNetwork({ id: 'mainnet' })).toBeNull();
  });

  it('knows no other network, and no other shape', () => {
    for (const bad of [
      { id: 'testnet10', genesis: TESTNET11_GENESIS },
      { id: 'Mainnet', genesis: MAINNET_GENESIS },
      { id: ' mainnet', genesis: MAINNET_GENESIS },
      { genesis: MAINNET_GENESIS },
      { id: 'mainnet', genesis: 7 },
      null, 'mainnet', 'testnet11', 7, true, [], [MAINNET], {},
    ]) {
      expect(parseChiaNetwork(bad)).toBeNull();
    }
  });
});

describe('networkOfId (a faucet status)', () => {
  it('is testnet11 when absent, the row for a known id, and none for anything else', () => {
    expect(networkOfId(undefined)).toBe(TESTNET11);
    expect(networkOfId('testnet11')).toBe(TESTNET11);
    expect(networkOfId('mainnet')).toBe(MAINNET);
    for (const bad of [null, '', 'Mainnet', 'testnet', 'simulator0', 7, {}]) expect(networkOfId(bad)).toBeNull();
  });
});

describe.each([TESTNET11, MAINNET])('isAddressOn($id)', (net) => {
  const other = net === TESTNET11 ? MAINNET : TESTNET11;
  const addr = addressOn(net, BODY);

  it('takes a standard-puzzle address with its own prefix', () => {
    expect(addr.startsWith(`${net.prefix}1`)).toBe(true);
    expect(isAddressOn(net, addr)).toBe(true);
  });

  it('refuses the other network\'s address, a broken one, and no network', () => {
    expect(isAddressOn(net, addressOn(other, BODY))).toBe(false);
    for (const bad of [addr.slice(0, -1) + 'b', addr.slice(0, -1), addr + 'q', addr.toUpperCase(), 'x' + addr, 42, null, undefined, '']) {
      expect(isAddressOn(net, bad)).toBe(false);
    }
    expect(isAddressOn(null, addr)).toBe(false);
    expect(isAddressOn(undefined, addr)).toBe(false);
  });
});
