import { describe, expect, it } from 'vitest';
import {
  asFaucetStatus,
  asMojos,
  blocksToMinutes,
  clearFaucetRoom,
  dishLine,
  failFaucetRequest,
  faucetPending,
  latestFaucetError,
  formatMojos,
  jarLevel,
  latestFaucetStatus,
  markFaucetPending,
  parseFaucetReply,
  setFaucetReply,
  type FaucetStatus,
} from './faucetDish';

const status = (over: Partial<FaucetStatus> = {}): FaucetStatus => ({
  address: 'txch1qqqq',
  puzzleHash: '00'.repeat(32),
  gift: 1,
  gap: 32,
  peak: 140,
  totalMojos: 1005n,
  coins: 2,
  ready: 1,
  nextReadyInBlocks: 22,
  canClaim: false,
  canGive: false,
  walletMojos: null,
  walletSpendableMojos: null,
  walletPartial: false,
  partial: false,
  note: '',
  snapshot: 0,
  ...over,
});

/** A status as the node puts it on the wire: mojo totals are decimal strings. */
const wire = (over: Partial<FaucetStatus> = {}): Record<string, unknown> => {
  const st = status(over);
  return {
    ...st,
    totalMojos: st.totalMojos.toString(),
    walletMojos: st.walletMojos === null ? null : st.walletMojos.toString(),
    walletSpendableMojos: st.walletSpendableMojos === null ? null : st.walletSpendableMojos.toString(),
  };
};

const b64 = (v: unknown): string => btoa(JSON.stringify(v));

describe('faucet dish: node replies', () => {
  it('parses a status reply and shape-guards it', () => {
    const reply = parseFaucetReply(b64({ op: 'status', ok: true, status: wire() }));
    expect(reply?.ok).toBe(true);
    expect(reply?.status?.coins).toBe(2);
    expect(reply?.status?.totalMojos).toBe(1005n);
    expect(reply?.status?.nextReadyInBlocks).toBe(22);
    expect(reply?.status?.partial).toBe(false);
    // nextReadyInBlocks null is a legal "everything is ready" value.
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: wire({ nextReadyInBlocks: null }) }))?.status?.nextReadyInBlocks).toBeNull();
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: wire({ partial: true }) }))?.status?.partial).toBe(true);
    // The wallet listing can be cut short too; an older node that never says so means "complete".
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: wire({ walletPartial: true }) }))?.status?.walletPartial).toBe(true);
    const older = wire() as Record<string, unknown>;
    delete older.walletPartial;
    expect(asFaucetStatus(older)?.walletPartial).toBe(false);
    // The node's snapshot number rides along; an older node that sends none orders nothing (0).
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: wire({ snapshot: 12 }) }))?.status?.snapshot).toBe(12);
    delete older.snapshot;
    expect(asFaucetStatus(older)?.snapshot).toBe(0);
    expect(asFaucetStatus({ ...wire(), snapshot: 'twelve' })?.snapshot).toBe(0);
  });

  it('keeps mojo totals exact past 2^53 and still reads a plain safe number', () => {
    // The node sends decimal strings; a JSON number would have rounded this.
    const big = parseFaucetReply(b64({ op: 'status', ok: true, status: { ...wire(), totalMojos: '18446744073709551615', walletMojos: '9007199254740993' } }));
    expect(big?.status?.totalMojos).toBe(18446744073709551615n);
    expect(big?.status?.walletMojos).toBe(9007199254740993n);
    // Spendable rides along as its own string; an older node that omits it means "all of it".
    const split = parseFaucetReply(b64({ op: 'status', ok: true, status: { ...wire(), walletMojos: '5000', walletSpendableMojos: '1200' } }));
    expect(split?.status?.walletSpendableMojos).toBe(1200n);
    const legacy = { ...wire(), walletMojos: '5000' } as Record<string, unknown>;
    delete legacy.walletSpendableMojos;
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: legacy }))?.status?.walletSpendableMojos).toBe(5000n);
    expect(asFaucetStatus({ ...wire(), walletSpendableMojos: 'some' })).toBeNull();
    // Several u64 coins can pass u64 together (the node sums in u128): 20 digits, up to 39, still exact.
    expect(asMojos('36893488147419103230')).toBe(36893488147419103230n);
    expect(asMojos('1'.repeat(39))).toBe(BigInt('1'.repeat(39)));
    expect(asMojos('1'.repeat(40))).toBeNull();
    expect(asMojos(1005)).toBe(1005n);
    expect(asMojos('0')).toBe(0n);
    expect(asMojos('-1')).toBeNull();
    expect(asMojos('1.5')).toBeNull();
    expect(asMojos(2 ** 53)).toBeNull();
    expect(asMojos(-1)).toBeNull();
  });

  it('rejects junk, bad shapes and negative numbers', () => {
    expect(parseFaucetReply('not base64 json')).toBeNull();
    expect(parseFaucetReply(b64({ ok: true }))).toBeNull();
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: { address: 1 } }))).toBeNull();
    expect(asFaucetStatus(wire({ coins: -1 }))).toBeNull();
    expect(asFaucetStatus({ ...wire(), ready: 'two' })).toBeNull();
    expect(asFaucetStatus({ ...wire(), walletMojos: 'lots' })).toBeNull();
    expect(asFaucetStatus({ ...wire(), totalMojos: '-5' })).toBeNull();
  });

  it('keeps an error reply and a spent coin', () => {
    const err = parseFaucetReply(b64({ op: 'claim', ok: false, error: 'no mojo in the dish right now' }));
    expect(err).toEqual({ op: 'claim', ok: false, error: 'no mojo in the dish right now' });
    const took = parseFaucetReply(b64({ op: 'claim', ok: true, spentCoin: 'ab'.repeat(32) }));
    expect(took?.spentCoin).toBe('ab'.repeat(32));
  });
});

describe('faucet dish: what it shows', () => {
  it('fills the jar by gift slots, not mojos', () => {
    expect(jarLevel(null)).toBe(0);
    expect(jarLevel(status({ coins: 0, totalMojos: 0n }))).toBe(0);
    expect(jarLevel(status({ coins: 2 }))).toBeCloseTo(0.25);
    expect(jarLevel(status({ coins: 8 }))).toBe(1);
    expect(jarLevel(status({ coins: 50, totalMojos: 10n ** 12n }))).toBe(1);
  });

  it('says what is in the dish', () => {
    expect(dishLine(null)).toBe('READING THE CHAIN…');
    expect(dishLine(status({ coins: 0, ready: 0 }))).toContain('JAR IS EMPTY');
    expect(dishLine(status({ ready: 1 }))).toBe('1 MOJO IN THE DISH');
    expect(dishLine(status({ ready: 3 }))).toBe('3 MOJOS IN THE DISH');
    expect(dishLine(status({ ready: 0, nextReadyInBlocks: 22 }))).toBe('DISH EMPTY · REFILLS IN 22 BLOCKS (~7 MIN)');
    expect(dishLine(status({ ready: 0, nextReadyInBlocks: 1 }))).toBe('DISH EMPTY · REFILLS IN 1 BLOCK (~1 MIN)');
    expect(dishLine(status({ ready: 0, nextReadyInBlocks: null }))).toBe('DISH EMPTY');
  });

  it('formats mojos with TXCH from a billion up', () => {
    expect(blocksToMinutes(32)).toBe(10);
    expect(formatMojos(1)).toBe('1 mojo');
    expect(formatMojos(1005)).toBe('1,005 mojos');
    expect(formatMojos(1_000_000_000)).toBe('1,000,000,000 mojos (0.001 TXCH)');
    expect(formatMojos(2.5e12)).toBe('2,500,000,000,000 mojos (2.500 TXCH)');
    expect(formatMojos(1005n)).toBe('1,005 mojos');
    expect(formatMojos(18446744073709551615n)).toBe('18,446,744,073,709,551,615 mojos (18446744.073 TXCH)');
    expect(formatMojos(-3n)).toBe('0 mojos');
  });
});

describe('faucet dish: per-room store', () => {
  it('files statuses and clears a pending take once the wallet holds a coin', () => {
    const room = 'home-store-1';
    clearFaucetRoom(room);
    expect(latestFaucetStatus(room)).toBeNull();
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, canClaim: true }) });
    expect(latestFaucetStatus(room)?.canClaim).toBe(true);
    markFaucetPending(room, 'claim', 1_000);
    expect(faucetPending(room, 2_000)).toBe('claim');
    // A status that still shows an empty wallet keeps the take pending…
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n }) });
    expect(faucetPending(room, 3_000)).toBe('claim');
    // …the one that shows the mojo landed clears it.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 1n, ready: 0 }) });
    expect(faucetPending(room, 4_000)).toBeNull();
    clearFaucetRoom(room);
  });

  it('clears a pending give when the wallet shrinks, drops it on a refusal, and times out', () => {
    const room = 'home-store-2';
    clearFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n }) });
    markFaucetPending(room, 'give', 10_000);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n }) });
    expect(faucetPending(room, 11_000)).toBeNull();
    markFaucetPending(room, 'give', 20_000);
    setFaucetReply(room, { op: 'give', ok: false, error: 'your wallet is empty' });
    expect(faucetPending(room, 21_000)).toBeNull();
    markFaucetPending(room, 'claim', 30_000);
    expect(faucetPending(room, 30_000 + 120_001)).toBeNull();
    clearFaucetRoom(room);
  });

  it('keeps the newest snapshot by the node\'s numbering, whatever order the replies arrive in', () => {
    const room = 'home-store-4';
    clearFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, canClaim: true, snapshot: 7 }) });
    // The node captured the post-claim read as snapshot 9 and an older poll as
    // 8 — the poll was SENT first but served second, or simply answered late.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 1n, canClaim: false, snapshot: 9 }) });
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, canClaim: true, snapshot: 8 }) });
    expect(latestFaucetStatus(room)?.walletMojos).toBe(1n);
    expect(latestFaucetStatus(room)?.canClaim).toBe(false);
    // A newer one still replaces it; an older node's unnumbered replies always do.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 2n, snapshot: 10 }) });
    expect(latestFaucetStatus(room)?.walletMojos).toBe(2n);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 3n }) });
    expect(latestFaucetStatus(room)?.walletMojos).toBe(3n);
    clearFaucetRoom(room);
  });

  it('drops a pending take at once when the request never reached the node, and says why', () => {
    const room = 'home-store-3';
    clearFaucetRoom(room);
    markFaucetPending(room, 'claim', 1_000);
    expect(faucetPending(room, 2_000)).toBe('claim');
    failFaucetRequest(room, 'claim', new Error('no connection to your node'));
    expect(faucetPending(room, 2_000)).toBeNull();
    expect(latestFaucetError(room)).toBe('the request did not reach your node (no connection to your node)');
    // A status that does arrive later clears the error.
    setFaucetReply(room, { op: 'status', ok: true, status: status() });
    expect(latestFaucetError(room)).toBeNull();
    clearFaucetRoom(room);
  });
});
