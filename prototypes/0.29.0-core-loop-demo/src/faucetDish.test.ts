import { describe, expect, it } from 'vitest';
import {
  asFaucetStatus,
  asMojos,
  blocksToMinutes,
  clearFaucetRoom,
  dishLine,
  failFaucetRequest,
  faucetPending,
  faucetPendingUnanswered,
  latestFaucetError,
  formatMojos,
  jarLevel,
  latestFaucetStatus,
  markFaucetPending,
  openFaucetRoom,
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
  spending: false,
  landing: false,
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
    // The node's settling flags ride along; an older node that sends none reads as "nothing in flight".
    expect(parseFaucetReply(b64({ op: 'status', ok: true, status: wire({ spending: true, landing: true }) }))?.status).toMatchObject({ spending: true, landing: true });
    expect(asFaucetStatus(older)).toMatchObject({ spending: false, landing: false });
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
  it('keeps a pending take until the node reports the gift landed or the claim settled, never on the clock', () => {
    const room = 'home-store-1';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    expect(latestFaucetStatus(room)).toBeNull();
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, canClaim: true, snapshot: 4 }) });
    expect(latestFaucetStatus(room)?.canClaim).toBe(true);
    markFaucetPending(room, 'claim', 1);
    expect(faucetPending(room)).toBe('claim');
    // A poll captured BEFORE the push (numbered below the reply's) answers late
    // with nothing in flight: it says nothing about the claim, so it stays.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, snapshot: 5 }) });
    expect(faucetPending(room)).toBe('claim');
    // The claim reply (echoing the request's seq) carries the first look after
    // the push: the gift is landing.
    setFaucetReply(room, { op: 'claim', ok: true, spentCoin: 'ab'.repeat(32), status: status({ walletMojos: 0n, landing: true, canClaim: false, snapshot: 6 }) }, 1);
    expect(faucetPending(room)).toBe('claim');
    // Still landing an hour of polls later: still pending (no timeout).
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, landing: true, snapshot: 200 }) });
    expect(faucetPending(room)).toBe('claim');
    // The snapshot that shows the mojo landed clears it.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 1n, ready: 0, snapshot: 201 }) });
    expect(faucetPending(room)).toBeNull();
    // A claim the chain DROPPED: the wallet is still empty, nothing is landing
    // any more — the action is over and the dish may be asked again.
    markFaucetPending(room, 'claim', 2);
    setFaucetReply(room, { op: 'claim', ok: true, status: status({ walletMojos: 0n, landing: true, snapshot: 202 }) }, 2);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, landing: false, canClaim: true, snapshot: 203 }) });
    expect(faucetPending(room)).toBeNull();
    clearFaucetRoom(room);
  });

  it('keeps a pending give while the node says the spend is settling, clears it when settled or refused', () => {
    const room = 'home-store-2';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 10 }) });
    markFaucetPending(room, 'give', 1);
    // The give reply: coins parked, the spend settling.
    setFaucetReply(room, { op: 'give', ok: true, spentCoin: 'cd'.repeat(32), status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 11 }) }, 1);
    expect(faucetPending(room)).toBe('give');
    // Polls that still see it settling keep it, however many.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 12 }) });
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 90 }) });
    expect(faucetPending(room)).toBe('give');
    // Settled: nothing parked any more (landed here: the balance is lower).
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 4_000n, snapshot: 91 }) });
    expect(faucetPending(room)).toBeNull();
    // Dropped: the balance is back in full and nothing is settling — over too.
    markFaucetPending(room, 'give', 2);
    setFaucetReply(room, { op: 'give', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 0n, spending: true, snapshot: 92 }) }, 2);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 4_000n, snapshot: 93 }) });
    expect(faucetPending(room)).toBeNull();
    // Before the reply arrives, a poll showing nothing in flight is not trusted
    // (it may predate the push), and neither is a lower balance: the wallet is
    // the node's, shared by every room and tab, so the drop can be another
    // action's gift while this spend is still parked (#245 review, round 18).
    markFaucetPending(room, 'give', 3);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 4_000n, snapshot: 94 }) });
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 3_000n, walletSpendableMojos: 3_000n, spending: true, snapshot: 95 }) });
    expect(faucetPending(room)).toBe('give');
    // Only the node's verdict past this action's barrier clears it.
    setFaucetReply(room, { op: 'give', ok: true, afterSnapshot: 95 }, 3);
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 2_000n, walletSpendableMojos: 2_000n, snapshot: 96 }) });
    expect(faucetPending(room)).toBeNull();
    // Refused: dropped at once, and the screen keeps the reason.
    markFaucetPending(room, 'give', 4);
    setFaucetReply(room, { op: 'give', ok: false, error: 'your wallet is empty' }, 4);
    expect(faucetPending(room)).toBeNull();
    expect(latestFaucetError(room)).toBe('your wallet is empty');
    clearFaucetRoom(room);
  });

  it('takes the floor from a give reply answered after a newer poll, without filing the older snapshot', () => {
    const room = 'home-store-5';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 10 }) });
    markFaucetPending(room, 'give', 1);
    // The 20 s poll captured after the push (12) answers before the give reply (11).
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 12 }) });
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'give', ok: true, spentCoin: 'ab'.repeat(32), status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 11 }) }, 1);
    // The newer snapshot stays on file, the spend still settles: pending.
    expect(latestFaucetStatus(room)?.snapshot).toBe(12);
    expect(faucetPending(room)).toBe('give');
    // The next poll shows it settled: cleared — the floor was recorded.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 4_000n, snapshot: 13 }) });
    expect(faucetPending(room)).toBeNull();
    // And a late reply arriving when the newer poll ALREADY shows the spend
    // settled clears it on the spot.
    markFaucetPending(room, 'claim', 2);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, landing: false, snapshot: 15 }) });
    expect(faucetPending(room)).toBe('claim'); // no floor yet: not trusted
    setFaucetReply(room, { op: 'claim', ok: true, status: status({ walletMojos: 0n, landing: true, snapshot: 14 }) }, 2);
    expect(latestFaucetStatus(room)?.snapshot).toBe(15);
    expect(faucetPending(room)).toBeNull();
    clearFaucetRoom(room);
  });

  it('settles a dropped spend from the node\'s barrier when the status read after the push failed', () => {
    const room = 'home-store-6';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 30 }) });
    markFaucetPending(room, 'give', 1);
    // The give went out, but the node's status read right after it failed: the
    // reply carries the barrier (30: every snapshot above it is after the push)
    // and no status.
    setFaucetReply(room, { op: 'give', ok: true, spentCoin: 'ab'.repeat(32), afterSnapshot: 30 }, 1);
    expect(faucetPending(room)).toBe('give');
    // The next polls: settling, settling, then dropped (balance back in full,
    // nothing parked). Cleared — without the barrier it never would be.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 31 }) });
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 32 }) });
    expect(faucetPending(room)).toBeNull();
    // A poll already on file above the barrier settles it the moment the
    // status-less reply arrives.
    markFaucetPending(room, 'give', 2);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 34 }) });
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'give', ok: true, afterSnapshot: 33 }, 2);
    expect(faucetPending(room)).toBeNull();
    // The barrier is parsed off the wire; the status alone still sets the floor for an older node.
    expect(parseFaucetReply(b64({ op: 'give', ok: true, afterSnapshot: 12 }))?.afterSnapshot).toBe(12);
    expect(parseFaucetReply(b64({ op: 'give', ok: true, afterSnapshot: 'later' }))?.afterSnapshot).toBeUndefined();
    clearFaucetRoom(room);
  });

  it('ties a take/give reply to its own request: an earlier action\'s late reply or refusal leaves the one pending now alone', () => {
    const room = 'home-store-7';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 40 }) });
    // GIVE #1 (request seq 1): its reply sets the floor, the next poll shows it settled.
    markFaucetPending(room, 'give', 1);
    setFaucetReply(room, { op: 'give', ok: true, afterSnapshot: 40 }, 1);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 4_000n, snapshot: 42 }) });
    expect(faucetPending(room)).toBeNull();
    // GIVE #2 (seq 2) begins; the newest poll on file shows nothing settling.
    markFaucetPending(room, 'give', 2);
    // A reply of GIVE #1 arrives again (a stream read late, or twice). Matched
    // by op alone, its floor (41) would meet the snapshot already on file (42,
    // nothing settling) and clear GIVE #2 at once, before its spend even left.
    // Matched by seq, it is not GIVE #2's.
    setFaucetReply(room, { op: 'give', ok: true, afterSnapshot: 40, status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 41 }) }, 1);
    expect(faucetPending(room)).toBe('give');
    expect(latestFaucetStatus(room)?.snapshot).toBe(42);
    // Nor does a late refusal of GIVE #1 refuse GIVE #2, or show as its error.
    setFaucetReply(room, { op: 'give', ok: false, error: 'your wallet is empty' }, 1);
    expect(faucetPending(room)).toBe('give');
    expect(latestFaucetError(room)).toBeNull();
    // A reply carrying no seq proves nothing about whose it is: no floor either.
    setFaucetReply(room, { op: 'give', ok: true, afterSnapshot: 41 });
    expect(faucetPending(room)).toBe('give');
    // GIVE #2's own reply sets the floor; the poll that shows it settled clears it.
    setFaucetReply(room, { op: 'give', ok: true, afterSnapshot: 42 }, 2);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 4_000n, walletSpendableMojos: 0n, spending: true, snapshot: 43 }) });
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 3_000n, walletSpendableMojos: 3_000n, snapshot: 44 }) });
    expect(faucetPending(room)).toBeNull();
    // An action's own refusal does refuse it.
    markFaucetPending(room, 'claim', 3);
    setFaucetReply(room, { op: 'claim', ok: false, error: 'no mojo in the dish right now' }, 3);
    expect(faucetPending(room)).toBeNull();
    expect(latestFaucetError(room)).toBe('no mojo in the dish right now');
    clearFaucetRoom(room);
  });

  it('keeps a give pending when the gateway did not answer the push, says so, and lets the node settle it', () => {
    const room = 'home-store-8';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 50 }) });
    markFaucetPending(room, 'give', 1);
    expect(faucetPendingUnanswered(room)).toBeNull();
    // The node pushed the gift and the gateway never answered: the coins stay
    // parked and the reply comes back SENT with the reason — not as a refusal,
    // which would re-enable GIVE while the first gift may still be live.
    setFaucetReply(room, { op: 'give', ok: true, unanswered: 'operation timed out', afterSnapshot: 50, status: status({ walletMojos: 5_000n, walletSpendableMojos: 0n, spending: true, snapshot: 51 }) }, 1);
    expect(faucetPending(room)).toBe('give');
    expect(faucetPendingUnanswered(room)).toBe('operation timed out');
    expect(latestFaucetError(room)).toBeNull();
    // The node's reconciliation settles it (dropped here: the balance is back in
    // full, nothing parked) — over, and the note goes with the action.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 5_000n, walletSpendableMojos: 5_000n, snapshot: 52 }) });
    expect(faucetPending(room)).toBeNull();
    expect(faucetPendingUnanswered(room)).toBeNull();
    // Off the wire.
    expect(parseFaucetReply(b64({ op: 'claim', ok: true, unanswered: 'connection reset' }))?.unanswered).toBe('connection reset');
    expect(parseFaucetReply(b64({ op: 'claim', ok: true, unanswered: 7 }))?.unanswered).toBeUndefined();
    clearFaucetRoom(room);
  });

  it('keeps the newest snapshot by the node\'s numbering, whatever order the replies arrive in', () => {
    const room = 'home-store-4';
    clearFaucetRoom(room);
    openFaucetRoom(room);
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
    openFaucetRoom(room);
    markFaucetPending(room, 'claim', 1);
    expect(faucetPending(room)).toBe('claim');
    failFaucetRequest(room, 'claim', 1, new Error('no connection to your node'));
    expect(faucetPending(room)).toBeNull();
    expect(latestFaucetError(room)).toBe('the request did not reach your node (no connection to your node)');
    // A status that does arrive later clears the error.
    setFaucetReply(room, { op: 'status', ok: true, status: status() });
    expect(latestFaucetError(room)).toBeNull();
    clearFaucetRoom(room);
  });

  it('reads a refusal the node issued before parsing the request (op "?") as the action\'s own when it carries its seq', () => {
    const room = 'home-store-9';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, canClaim: true, snapshot: 60 }) });
    markFaucetPending(room, 'claim', 7);
    // The node refuses a request before reading its op (not its local browser,
    // or not JSON) under op "?". A status poll's refusal (another seq) shows on
    // the screen — the whole dish is refused then — but is not this action's.
    setFaucetReply(room, { op: '?', ok: false, error: "faucet requests are the LOCAL browser's alone" }, 6);
    expect(faucetPending(room)).toBe('claim');
    expect(latestFaucetError(room)).toBe("faucet requests are the LOCAL browser's alone");
    // THIS request's refusal, by its seq: the TAKE is over and the buttons return.
    setFaucetReply(room, { op: '?', ok: false, error: "faucet requests are the LOCAL browser's alone" }, 7);
    expect(faucetPending(room)).toBeNull();
    // Under the action's own op the seq decides the same way.
    markFaucetPending(room, 'give', 8);
    setFaucetReply(room, { op: '?', ok: false, error: 'bad request' });
    expect(faucetPending(room)).toBe('give');
    setFaucetReply(room, { op: 'give', ok: false, error: 'your wallet is empty' }, 8);
    expect(faucetPending(room)).toBeNull();
    clearFaucetRoom(room);
  });

  it('files replies, request failures and pending actions only for the open room, so a room left mid-flight gets nothing back', () => {
    const room = 'home-store-10';
    clearFaucetRoom(room);
    openFaucetRoom(room);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, canClaim: true, snapshot: 70 }) });
    markFaucetPending(room, 'claim', 1);
    expect(latestFaucetStatus(room)?.snapshot).toBe(70);
    // The room is left: its state goes and the gate closes, synchronously.
    clearFaucetRoom(room);
    expect(latestFaucetStatus(room)).toBeNull();
    // A poll answered during the leave's flush, the failure of a request that
    // could not leave, and a click landing late all resolve afterwards: none
    // puts anything back for the departed room.
    setFaucetReply(room, { op: 'status', ok: true, status: status({ walletMojos: 0n, snapshot: 71 }) });
    failFaucetRequest(room, 'claim', 1, new Error('stream closed'));
    markFaucetPending(room, 'give', 2);
    expect(latestFaucetStatus(room)).toBeNull();
    expect(latestFaucetError(room)).toBeNull();
    expect(faucetPending(room)).toBeNull();
    // The next room opened is the only one filed; the departed room's replies
    // still go nowhere.
    const next = 'home-store-11';
    clearFaucetRoom(next);
    openFaucetRoom(next);
    setFaucetReply(room, { op: 'status', ok: true, status: status({ snapshot: 72 }) });
    setFaucetReply(next, { op: 'status', ok: true, status: status({ snapshot: 1 }) });
    failFaucetRequest(room, 'status', 3, new Error('no connection'));
    expect(latestFaucetStatus(room)).toBeNull();
    expect(latestFaucetError(room)).toBeNull();
    expect(latestFaucetStatus(next)?.snapshot).toBe(1);
    clearFaucetRoom(next);
  });
});
