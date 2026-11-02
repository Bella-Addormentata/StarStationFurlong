/**
 * ⛓️ The Chia network the local node runs on (stage 2 of the mainnet
 * transition): testnet11 or Chia mainnet.
 *
 * The node reports its network in the fingerprint (`chia_network`: an id, the
 * genesis challenge and where the choice came from) and in each faucet status
 * (`network`: the id). This page owns every label: the address prefix, the
 * ticker, the name and the wording come from the two fixed rows here, never
 * from the node. A row is used only when the node's id and genesis both match
 * it, so a node bug or a stranger answering on the port cannot make the page
 * show a prefix or a ticker it does not know. A node that sends no network
 * (every node before stage 2) runs on testnet11. A network the page does not
 * know is `null`: the page then hides every address and QR code and says why.
 *
 * The treasury's network is a build setting of its own (treasuryNetwork.ts),
 * not this one.
 */

export type ChiaNetworkId = 'testnet11' | 'mainnet';

export interface ChiaNetwork {
  /** The node's id for it (`ChiaNet::id()` in ssf-p2p-node). */
  readonly id: ChiaNetworkId;
  /** The genesis challenge, 64 lowercase hex digits. */
  readonly genesis: string;
  /** The bech32m prefix of its addresses. */
  readonly prefix: 'txch' | 'xch';
  /** Its coin's ticker. */
  readonly ticker: 'TXCH' | 'XCH';
  /** The name the texts use: "testnet11", "Chia mainnet". */
  readonly name: string;
  /** Where the Phone Book is written, as the texts say it. */
  readonly chain: string;
  /** Its coins, as the texts say them. */
  readonly coins: string;
  /** A test network: its coins are free and worth nothing. */
  readonly test: boolean;
}

export const TESTNET11: ChiaNetwork = Object.freeze({
  id: 'testnet11',
  genesis: '37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615',
  prefix: 'txch',
  ticker: 'TXCH',
  name: 'testnet11',
  chain: 'the test chain',
  coins: 'testnet coins',
  test: true,
});

export const MAINNET: ChiaNetwork = Object.freeze({
  id: 'mainnet',
  genesis: 'ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb',
  prefix: 'xch',
  ticker: 'XCH',
  name: 'Chia mainnet',
  chain: 'Chia mainnet',
  coins: 'mainnet coins',
  test: false,
});

/** Every network the page knows. */
export const CHIA_NETWORKS: readonly ChiaNetwork[] = Object.freeze([TESTNET11, MAINNET]);

/** Mojos in one coin (one TXCH or one XCH). */
export const MOJOS_PER_COIN = 1_000_000_000_000n;

/** The node's `chia_network` field as one of the rows: `undefined` when the
 *  field is absent (the node runs on testnet11), `null` when it is present
 *  but names no row here (an unknown id, a genesis that does not match its
 *  id, or not the node's shape). */
export function parseChiaNetwork(v: unknown): ChiaNetwork | null | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.genesis !== 'string') return null;
  const genesis = r.genesis.toLowerCase();
  return CHIA_NETWORKS.find((n) => n.id === r.id && n.genesis === genesis) ?? null;
}

/** The network a faucet status names (`network`: an id only): absent is
 *  testnet11, an id this page does not know is `null`. */
export function networkOfId(v: unknown): ChiaNetwork | null {
  if (v === undefined) return TESTNET11;
  return CHIA_NETWORKS.find((n) => n.id === v) ?? null;
}

/** A standard-puzzle address on `net`: its prefix, the bech32m separator and
 *  58 bech32 characters (52 for 32 bytes of puzzle hash, 6 of checksum). The
 *  character set is bech32's (no `1`, `b`, `i`, `o`). The checksum is the
 *  node's to verify: this is the shape check that keeps a stray string, or
 *  an address of another network, out of the Bank's QR code. False for an
 *  unknown network. */
export function isAddressOn(net: ChiaNetwork | null | undefined, v: unknown): v is string {
  if (!net || typeof v !== 'string') return false;
  return new RegExp(`^${net.prefix}1[02-9ac-hj-np-z]{58}$`).test(v);
}

/** An address on `net` with `body` after the separator, for test fixtures. */
export function addressOn(net: ChiaNetwork, body: string): string {
  return `${net.prefix}1${body}`;
}
