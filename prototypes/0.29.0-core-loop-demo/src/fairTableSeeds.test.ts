/**
 * ⚖️ Fair-by-default craps + roulette: the live seed exchange (house commit at
 * open, bettors' commits frozen at "no more bets", reveals, the mixed result)
 * against a real Yjs-backed casino map, driven through the operator ticks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Modules under test hang debug handles on window when they load.
vi.stubGlobal('window', { location: { search: '' } });

const {
  bindCasinoDoc, buyInChips, readAllCrapsBets, readChips, readCrapsTableState, readDiceThrow, readSeedRecord,
  readTableState, writeCrapsFairnessPref, writeCrapsTableState, writeMyBets, writeMyCrapsBets,
  writeMySeedRecord, writeTableState,
} = await import('./casinoDoc');
const {
  BET_WINDOW_MS, CLOSING_MS, rollAndSettle, ROULETTE_PAGE_ID, SHOW_MS, setSoleCroupierPredicate, tickAutoCroupier,
} = await import('./croupier');
const { CRAPS_BET_WINDOW_MS, CRAPS_CLOSING_MS, pressManualRoll, stickmanThrows, tickAutoStickman } = await import('./crapsCroupier');
const {
  commitSeedSync, forgetMissingTables, keyFor, seedSigBytes, frozenWagers, isFairTable, REVEAL_GRACE_MS, roundIsFair, tickFairSeeds, verifySettledRound,
  wagerFingerprint,
} = await import('./fairTableSeeds');
const { pocketFromMaterial } = await import('./games/fairDice');
const { commitTableSeed } = await import('./games/diceFairness');
const { getIdentityPub, signIdentity } = await import('./keypair');

const ed = await import('@noble/ed25519');
const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Someone else's identity key: signs anything, but isn't Amy's or Bob's. */
const ATTACKER = (() => {
  const priv = ed.etc.randomBytes(32);
  return { pub: b64url(ed.getPublicKey(priv)), sign: (m: Uint8Array) => b64url(ed.sign(m, priv)) };
})();

/** A bettor's signature over `commit`, as its own client would make it. */
function signFor(table: string, round: number, party: string, house: string, commit: string, room = ''): string {
  return signIdentity(seedSigBytes({ room, table, round, party, house }, commit));
}
type RouletteTableState = import('./games/roulette').RouletteTableState;
type CrapsTableState = import('./games/craps').CrapsTableState;

const T0 = 2_000_000_000;
const AMY = 'player-Amy';
const BOB = 'player-Bob';

let room: Y.Doc;
let tableN = 0;
const freshTable = (): string => `fair-test-${++tableN}`;

let now = T0;
function at(t: number): number {
  now = t;
  vi.setSystemTime(t);
  return t;
}
function later(ms: number): number {
  return at(now + ms);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Both players' clients take a look (past the 200 ms throttle). */
function playersLook(tableId: string, game: 'craps' | 'roulette', who = [AMY, BOB]): void {
  later(250);
  for (const pid of who) tickFairSeeds(tableId, game, pid);
}

/** A fresh room doc where Amy and Bob carry this page's identity key (one
 *  page plays both of them here). */
function freshRoom(roomId = ''): Y.Doc {
  const doc = new Y.Doc();
  for (const pid of [AMY, BOB]) doc.getMap('players').set(pid, { name: pid, keyB64: getIdentityPub() });
  bindCasinoDoc(doc, roomId);
  return doc;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  room = freshRoom();
  setSoleCroupierPredicate(() => true);
  buyInChips(AMY, 100);
  buyInChips(BOB, 100);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('commitments and the wheel', () => {
  it('the sync commitment matches the async one byte for byte', async () => {
    const seed = 'ab'.repeat(32);
    const ctx = { table: 't', round: 3, party: AMY, house: 'c'.repeat(64) };
    expect(commitSeedSync(seed, ctx)).toBe(await commitTableSeed(seed, ctx));
  });

  it('binds a commitment to its room, table, round, party and house commit', () => {
    const seed = 'ab'.repeat(32);
    const ctx = { table: 't', round: 3, party: AMY, house: 'c'.repeat(64) };
    const c = commitSeedSync(seed, ctx);
    for (const other of [
      { ...ctx, room: 'another-room' }, { ...ctx, table: 'u' }, { ...ctx, round: 4 }, { ...ctx, party: BOB }, { ...ctx, house: 'd'.repeat(64) },
    ]) expect(commitSeedSync(seed, other)).not.toBe(c);
  });

  it('a pocket is always 0–36, and every pocket comes up', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const p = await pocketFromMaterial(`t|${i}`);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(36);
      seen.add(p);
    }
    expect(seen.size).toBe(37);
  });

  it('tables are Fair unless the owner picks plain RNG', () => {
    const t = freshTable();
    expect(isFairTable(t)).toBe(true);
    writeCrapsFairnessPref(t, 'rng');
    expect(isFairTable(t)).toBe(false);
  });
});

/** Open a roulette round, have Amy and Bob bet, and run it to "no more bets". */
function rouletteToClosing(t: string): RouletteTableState {
  tickAutoCroupier(t); // opens round 1
  const open = readTableState(t)!;
  expect(open.houseCommit).toMatch(/^[0-9a-f]{64}$/);
  writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
  writeMyBets(t, BOB, 1, [{ type: 'black', amount: 10 }]);
  tickAutoCroupier(t); // arms the window
  playersLook(t, 'roulette'); // both commit
  expect(readSeedRecord(t, AMY)?.house).toBe(open.houseCommit);
  later(BET_WINDOW_MS);
  tickAutoCroupier(t); // closes, freezing the commits
  const closing = readTableState(t)!;
  expect(closing.phase).toBe('closing');
  expect(Object.keys(closing.commits ?? {}).sort()).toEqual([AMY, BOB]);
  return closing;
}

describe('a Fair roulette round', () => {
  it('mixes the house and both bettors into a pocket anyone can verify', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // both reveal
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.fairness?.parties).toEqual(['house', AMY, BOB]);
    expect(s.fairness?.seeds?.every((x) => x.length === 64)).toBe(true);
    const v = await verifySettledRound('roulette', t, s, { pocket: s.result! });
    expect(v).toMatchObject({
      kind: 'verified', forfeited: [], houseMissing: false, droppedReveal: false, unseeded: [], bettorSeeds: 2,
      watchedClose: true,
    });
    expect(v.kind === 'verified' && v.mine).toBeUndefined(); // no player named
    const amy = await verifySettledRound('roulette', t, s, { pocket: s.result! }, AMY);
    expect(amy).toMatchObject({ kind: 'verified', mine: 'in' });
    // A different pocket fails the check.
    const wrong = await verifySettledRound('roulette', t, s, { pocket: (s.result! + 1) % 37 });
    expect(wrong.kind).toBe('failed');
  });

  it('waits for a missing reveal, then forfeits that bettor', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette', [AMY]); // Bob never reveals
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    expect(readTableState(t)?.phase).toBe('closing'); // still waiting on Bob
    later(REVEAL_GRACE_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.payouts?.[BOB]).toBeUndefined();
    const v = await verifySettledRound('roulette', t, s, { pocket: s.result! }, BOB);
    expect(v).toMatchObject({ kind: 'verified', forfeited: [BOB], droppedReveal: false, mine: 'left-out' });
  });

  it('flags an operator who left out a seed it could see', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // both reveal
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    // Rewrite the transcript as if Bob had withheld: the mix of the rest.
    const { settleParties } = await import('./games/diceFairness');
    const f = s.fairness!;
    const mixed = await settleParties('roulette', [
      { id: 'house', commit: f.commits![0], seed: f.seeds![0] },
      { id: AMY, commit: f.commits![1], seed: f.seeds![1] },
      { id: BOB, commit: f.commits![2], seed: null },
    ], t, 1);
    const forged: RouletteTableState = { ...s, result: mixed!.pocket!, fairness: mixed!.transcript };
    writeTableState(t, forged);
    const v = await verifySettledRound('roulette', t, forged, { pocket: forged.result! });
    expect(v).toMatchObject({ kind: 'verified', forfeited: [BOB], droppedReveal: true });
  });

  it('refuses a transcript whose parties are not the frozen commit set', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette');
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    const f = s.fairness!;
    const dropped: RouletteTableState = {
      ...s,
      fairness: { ...f, parties: f.parties!.slice(0, 2), commits: f.commits!.slice(0, 2), seeds: f.seeds!.slice(0, 2) },
    };
    expect((await verifySettledRound('roulette', t, dropped, { pocket: s.result! })).kind).toBe('failed');
  });

  it('refuses a settled round whose commit set differs from the one frozen before reveals', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // both reveal (and snapshot the frozen set)
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    // The operator drops Bob from both the frozen set and the transcript after
    // seeing the reveals: self-consistent, but not what was frozen.
    const { settleParties } = await import('./games/diceFairness');
    const f = s.fairness!;
    const mixed = await settleParties('roulette', [
      { id: 'house', commit: f.commits![0], seed: f.seeds![0] },
      { id: AMY, commit: f.commits![1], seed: f.seeds![1] },
    ], t, 1);
    const forged: RouletteTableState = {
      ...s, commits: { [AMY]: s.commits![AMY] }, result: mixed!.pocket!, fairness: mixed!.transcript,
    };
    expect((await verifySettledRound('roulette', t, forged, { pocket: forged.result! })).kind).toBe('failed');
  });

  it("a commitment copied in from another open table doesn't make this page reveal that table's seed", () => {
    const a = freshTable();
    const closingA = rouletteToClosing(a);
    const amyOnA = closingA.commits![AMY];
    const b = freshTable();
    tickAutoCroupier(b);
    writeMyBets(b, AMY, 1, [{ type: 'red', amount: 5 }]);
    const openB = readTableState(b)!;
    // B's operator writes Amy's public commitment from table A as her record
    // on B, and freezes it.
    writeMySeedRecord(b, AMY, { round: 1, house: openB.houseCommit!, commit: amyOnA });
    writeTableState(b, { ...openB, phase: 'closing', commits: { [AMY]: amyOnA } });
    playersLook(b, 'roulette', [AMY]);
    const onB = readSeedRecord(b, AMY);
    expect(onB?.commit === amyOnA && onB.seed).toBeFalsy();
    // Table A still reveals normally.
    playersLook(a, 'roulette', [AMY]);
    const onA = readSeedRecord(a, AMY)!;
    expect(onA.seed).toBeTruthy();
    expect(commitSeedSync(onA.seed!, { table: a, round: 1, party: AMY, house: closingA.houseCommit! })).toBe(amyOnA);
  });

  it('a bet rewritten after "no more bets" is not paid', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // both reveal: the pocket is computable now
    // Bob swaps his black for bets that win on any pocket.
    writeMyBets(t, BOB, 1, [
      { type: 'red', amount: 10 }, { type: 'black', amount: 10 }, { type: 'straight', pick: 0, amount: 10 },
    ]);
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.payouts?.[BOB]).toBeUndefined();
  });

  it("rewriting the closing state's wager hash too doesn't get a rewritten bet paid", async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette');
    const winAll = [
      { type: 'red' as const, amount: 10 }, { type: 'black' as const, amount: 10 }, { type: 'straight' as const, pick: 0, amount: 10 },
    ];
    writeMyBets(t, BOB, 1, winAll);
    const closing = readTableState(t)!;
    writeTableState(t, { ...closing, wagers: { ...closing.wagers, [BOB]: wagerFingerprint(winAll) } });
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.payouts?.[BOB]).toBeUndefined();
    expect(s.wagers?.[BOB]).not.toBe(wagerFingerprint(winAll)); // the frozen copy is what's published
  });

  it("a rewritten house commit can't dodge the frozen snapshot", async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // snapshots the frozen set under this round
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    // A self-consistent rewrite: a fresh house seed alone decides the pocket.
    const { settleParties } = await import('./games/diceFairness');
    const seed = 'ab'.repeat(32);
    const house = commitSeedSync(seed, { room: '', table: t, round: 1, party: 'house', house: '' });
    const mixed = await settleParties('roulette', [{ id: 'house', commit: house, seed }], t, 1);
    const forged: RouletteTableState = {
      ...s, houseCommit: house, commits: {}, unseeded: undefined, wagers: undefined,
      result: mixed!.pocket!, fairness: mixed!.transcript,
    };
    expect((await verifySettledRound('roulette', t, forged, { pocket: forged.result! })).kind).toBe('failed');
  });

  it("a round under another page's SPIN lease isn't settled here", async () => {
    const t = freshTable();
    const closing = rouletteToClosing(t);
    writeTableState(t, { ...closing, operator: 'player-Other:abc123' });
    playersLook(t, 'roulette');
    later(CLOSING_MS);
    rollAndSettle(t, closing.round);
    await flush();
    expect(readTableState(t)?.phase).toBe('closing');
    writeTableState(t, { ...readTableState(t)!, operator: ROULETTE_PAGE_ID });
    rollAndSettle(t, closing.round);
    await flush();
    expect(readTableState(t)?.phase).toBe('settled');
  });

  it('a table removed from the room forgets its snapshot, so a recreated one verifies afresh', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // snapshot for round 1
    forgetMissingTables(new Set()); // the table left the room
    // Recreated under the same id: a different round 1, never witnessed here.
    const { settleParties } = await import('./games/diceFairness');
    const seed = 'cd'.repeat(32);
    const house = commitSeedSync(seed, { room: '', table: t, round: 1, party: 'house', house: '' });
    const mixed = await settleParties('roulette', [{ id: 'house', commit: house, seed }], t, 1);
    const fresh: RouletteTableState = {
      kind: 'roulette', phase: 'settled', round: 1, result: mixed!.pocket!, resultAt: 0, payouts: {},
      houseCommit: house, commits: {}, fairness: mixed!.transcript,
    };
    expect(await verifySettledRound('roulette', t, fresh, { pocket: fresh.result! }))
      .toMatchObject({ kind: 'verified', watchedClose: false });
  });

  it('a round whose house seed is gone is void, and every stake goes back', async () => {
    const t = freshTable();
    tickAutoCroupier(t);
    // The operator page no longer holds this house commit's seed (lost on reload).
    writeTableState(t, { ...readTableState(t)!, houseCommit: 'f'.repeat(64) });
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]);
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]);
    const before = readChips(AMY);
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s).toMatchObject({ phase: 'settled', result: null, voided: true, payouts: {} });
    expect(readChips(AMY)).toBe(before + 10);
  });

  it('erasing the house commit after the close still settles Fair, by the frozen one', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette');
    writeTableState(t, { ...readTableState(t)!, houseCommit: undefined });
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.voided).toBeUndefined();
    expect(s.fairness?.parties?.[0]).toBe('house');
    expect(s.houseCommit).toBeTruthy();
  });

  it('a void round refunds only the frozen stake, not a list inflated after the close', async () => {
    const t = freshTable();
    tickAutoCroupier(t);
    writeTableState(t, { ...readTableState(t)!, houseCommit: 'f'.repeat(64) });
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]);
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]);
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 90 }]); // rewritten after the close
    const before = readChips(AMY);
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    expect(readTableState(t)).toMatchObject({ phase: 'settled', voided: true });
    expect(readChips(AMY)).toBe(before);
  });

  it("a void round refunds a bettor who never revealed, too", async () => {
    const t = freshTable();
    tickAutoCroupier(t);
    writeTableState(t, { ...readTableState(t)!, houseCommit: 'f'.repeat(64) });
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    writeMyBets(t, BOB, 1, [{ type: 'black', amount: 10 }]);
    tickAutoCroupier(t);
    playersLook(t, 'roulette');
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]); // Bob never reveals
    const before = readChips(BOB);
    later(CLOSING_MS);
    tickAutoCroupier(t); // the settle waits on Bob
    await flush();
    later(REVEAL_GRACE_MS);
    tickAutoCroupier(t);
    await flush();
    expect(readTableState(t)).toMatchObject({ phase: 'settled', voided: true });
    expect(readChips(BOB)).toBe(before + 10);
  });

  it('the plaque stays Fair when the house commit is erased after the close', () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette');
    writeTableState(t, { ...readTableState(t)!, houseCommit: undefined });
    expect(roundIsFair(t, 'roulette')).toBe(true);
  });

  it('joining another room right away still lets this room take a seed tick', () => {
    const t = freshTable();
    tickAutoCroupier(t);
    tickFairSeeds(t, 'roulette', AMY); // throttles this table for Amy, in the old room
    freshRoom();
    buyInChips(AMY, 100);
    tickAutoCroupier(t);
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    tickAutoCroupier(t);
    tickFairSeeds(t, 'roulette', AMY); // same instant, new room
    expect(readSeedRecord(t, AMY)?.house).toBe(readTableState(t)?.houseCommit);
  });

  it("a seed record under Amy's name that her key didn't sign is no party", () => {
    const t = freshTable();
    tickAutoCroupier(t);
    const open = readTableState(t)!;
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    tickAutoCroupier(t);
    // Amy's page never looks; someone else writes a record in her name.
    const commit = commitSeedSync('ab'.repeat(32), { room: '', table: t, round: 1, party: AMY, house: open.houseCommit! });
    const sig = ATTACKER.sign(seedSigBytes({ room: '', table: t, round: 1, party: AMY, house: open.houseCommit! }, commit));
    writeMySeedRecord(t, AMY, { round: 1, house: open.houseCommit!, commit, sig });
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    const closing = readTableState(t)!;
    expect(closing.commits?.[AMY]).toBeUndefined();
    expect(closing.unseeded).toEqual([AMY]);
  });

  it("rewriting Amy's key in the players map after this page saw it doesn't let another key sign for her", () => {
    const t = freshTable();
    tickAutoCroupier(t);
    const open = readTableState(t)!;
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    tickAutoCroupier(t);
    expect(keyFor(AMY)).toBe(getIdentityPub()); // seen (and pinned) here
    room.getMap('players').set(AMY, { name: AMY, keyB64: ATTACKER.pub });
    const ctx = { room: '', table: t, round: 1, party: AMY, house: open.houseCommit! };
    const commit = commitSeedSync('ab'.repeat(32), ctx);
    writeMySeedRecord(t, AMY, { round: 1, house: open.houseCommit!, commit, sig: ATTACKER.sign(seedSigBytes(ctx, commit)) });
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    expect(readTableState(t)?.commits?.[AMY]).toBeUndefined();
  });

  it("a published round that seeds in Amy's name without her signature fails the check", async () => {
    const t = freshTable();
    const { settleParties } = await import('./games/diceFairness');
    const hs = 'cd'.repeat(32);
    const house = commitSeedSync(hs, { room: '', table: t, round: 1, party: 'house', house: '' });
    const as = 'ef'.repeat(32);
    const ctx = { room: '', table: t, round: 1, party: AMY, house };
    const commit = commitSeedSync(as, ctx);
    const mixed = await settleParties('roulette', [{ id: 'house', commit: house, seed: hs }, { id: AMY, commit, seed: as }], t, 1);
    const base: RouletteTableState = {
      kind: 'roulette', phase: 'settled', round: 1, result: mixed!.pocket!, resultAt: 0, payouts: {},
      houseCommit: house, commits: { [AMY]: commit }, fairness: mixed!.transcript,
    };
    const forged = { ...base, sigs: { [AMY]: ATTACKER.sign(seedSigBytes(ctx, commit)) } };
    expect((await verifySettledRound('roulette', t, forged, { pocket: base.result! })).kind).toBe('failed');
    expect((await verifySettledRound('roulette', t, base, { pocket: base.result! })).kind).toBe('failed');
    const honest = { ...base, sigs: { [AMY]: signFor(t, 1, AMY, house, commit) } };
    expect((await verifySettledRound('roulette', t, honest, { pocket: base.result! })).kind).toBe('verified');
  });

  it("a player's key is pinned when the room shows it, before any seed is checked", () => {
    const t = freshTable();
    // Rewritten right after this page joined, before Amy ever bets.
    room.getMap('players').set(AMY, { name: AMY, keyB64: ATTACKER.pub });
    // A player who arrives later is pinned on arrival too.
    room.getMap('players').set('player-Cat', { name: 'Cat', keyB64: getIdentityPub() });
    room.getMap('players').set('player-Cat', { name: 'Cat', keyB64: ATTACKER.pub });
    expect(keyFor(AMY)).toBe(getIdentityPub());
    expect(keyFor('player-Cat')).toBe(getIdentityPub());
    tickAutoCroupier(t);
    const open = readTableState(t)!;
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    tickAutoCroupier(t);
    const ctx = { room: '', table: t, round: 1, party: AMY, house: open.houseCommit! };
    const commit = commitSeedSync('ab'.repeat(32), ctx);
    writeMySeedRecord(t, AMY, { round: 1, house: open.houseCommit!, commit, sig: ATTACKER.sign(seedSigBytes(ctx, commit)) });
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    expect(readTableState(t)?.commits?.[AMY]).toBeUndefined();
  });

  it('a bet that missed the freeze is returned, not lost', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    writeMyBets(t, 'player-Late', 1, [{ type: 'red', amount: 7 }]); // lands just after the close
    playersLook(t, 'roulette');
    const before = readChips('player-Late');
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    expect(readTableState(t)?.phase).toBe('settled');
    expect(readChips('player-Late')).toBe(before + 7);
  });

  it('a published round without the house seed fails the check', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette');
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    const { settleParties } = await import('./games/diceFairness');
    const f = s.fairness!;
    const mixed = await settleParties('roulette', [
      { id: 'house', commit: f.commits![0], seed: null },
      { id: AMY, commit: f.commits![1], seed: f.seeds![1] },
      { id: BOB, commit: f.commits![2], seed: f.seeds![2] },
    ], t, 1);
    const forged: RouletteTableState = { ...s, result: mixed!.pocket!, fairness: mixed!.transcript };
    expect((await verifySettledRound('roulette', t, forged, { pocket: forged.result! })).kind).toBe('failed');
  });

  it("an earlier round's commitment of mine copied into this round is replaced, not kept", async () => {
    const t = freshTable();
    rouletteToClosing(t);
    const amyR1 = readTableState(t)!.commits![AMY];
    playersLook(t, 'roulette');
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    later(SHOW_MS);
    tickAutoCroupier(t); // round 2 opens
    const r2 = readTableState(t)!;
    writeMyBets(t, AMY, 2, [{ type: 'red', amount: 10 }]);
    writeMySeedRecord(t, AMY, { round: 2, house: r2.houseCommit!, commit: amyR1 }); // copied in
    playersLook(t, 'roulette', [AMY]);
    expect(readSeedRecord(t, AMY)?.commit).not.toBe(amyR1);
  });

  it('a bettor id too long for the closing state is left out instead of wedging the table', () => {
    const t = freshTable();
    tickAutoCroupier(t);
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 10 }]);
    writeMyBets(t, 'x'.repeat(200), 1, [{ type: 'black', amount: 10 }]);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]);
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    const closing = readTableState(t);
    expect(closing?.phase).toBe('closing');
    expect(Object.keys(closing?.commits ?? {})).toEqual([AMY]);
    expect(closing?.unseeded).toBeUndefined();
  });

  it("many other tables closing doesn't evict this table's frozen snapshot", async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette'); // reveals, and snapshots the frozen set
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    // Seventy other tables close on this page afterwards.
    for (let i = 0; i < 70; i++) {
      const o = freshTable();
      tickAutoCroupier(o);
      const st = readTableState(o)!;
      writeTableState(o, { ...st, phase: 'closing', commits: {} });
      tickFairSeeds(o, 'roulette', AMY, Date.now(), true);
    }
    const v = await verifySettledRound('roulette', t, s, { pocket: s.result! });
    expect(v).toMatchObject({ kind: 'verified', watchedClose: true });
  });

  it("a seed revealed last round can't be replayed as this round's", async () => {
    const t = freshTable();
    rouletteToClosing(t);
    playersLook(t, 'roulette');
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const r1 = readTableState(t)!;
    const bobSeed = r1.fairness!.seeds![2];
    const bobCommit = r1.fairness!.commits![2];
    later(SHOW_MS);
    tickAutoCroupier(t); // round 2 opens
    const r2 = readTableState(t)!;
    writeMyBets(t, AMY, 2, [{ type: 'red', amount: 10 }]);
    writeMyBets(t, BOB, 2, [{ type: 'black', amount: 10 }]);
    tickAutoCroupier(t);
    playersLook(t, 'roulette', [AMY]);
    // Bob's client replays round 1's public commit + seed instead of a fresh one.
    const sig = signFor(t, 2, BOB, r2.houseCommit!, bobCommit);
    writeMySeedRecord(t, BOB, { round: 2, house: r2.houseCommit!, commit: bobCommit, sig });
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    expect(readTableState(t)?.commits?.[BOB]).toBe(bobCommit);
    playersLook(t, 'roulette', [AMY]);
    writeMySeedRecord(t, BOB, { round: 2, house: r2.houseCommit!, commit: bobCommit, seed: bobSeed, sig });
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    later(REVEAL_GRACE_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    // The old seed doesn't open a round-2 commitment: Bob counts as withheld.
    expect(s.fairness?.seeds?.[s.fairness.parties!.indexOf(BOB)]).toBe('');
    expect(s.payouts?.[BOB]).toBeUndefined();
  });

  it('a round opened Fair settles Fair even if the owner switches to RNG mid-round', async () => {
    const t = freshTable();
    rouletteToClosing(t);
    writeCrapsFairnessPref(t, 'rng');
    playersLook(t, 'roulette');
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.fairness?.parties).toEqual(['house', AMY, BOB]);
    later(SHOW_MS);
    tickAutoCroupier(t); // the next round opens as RNG
    expect(readTableState(t)?.houseCommit).toBeUndefined();
  });

  it('records a staked player who added no seed, and says the house seed was all there was', async () => {
    const t = freshTable();
    tickAutoCroupier(t);
    writeMyBets(t, BOB, 1, [{ type: 'black', amount: 10 }]);
    tickAutoCroupier(t);
    // Bob's client never looks (offline, or the house closed at once).
    later(BET_WINDOW_MS);
    tickAutoCroupier(t);
    expect(readTableState(t)?.unseeded).toEqual([BOB]);
    later(CLOSING_MS);
    tickAutoCroupier(t);
    await flush();
    const s = readTableState(t)!;
    expect(s.phase).toBe('settled');
    const v = await verifySettledRound('roulette', t, s, { pocket: s.result! });
    expect(v).toMatchObject({ kind: 'verified', unseeded: [BOB], bettorSeeds: 0 });
    // Clearing the published list doesn't hide him: the frozen wagers say so.
    const hidden: RouletteTableState = { ...s, unseeded: [] };
    expect(await verifySettledRound('roulette', t, hidden, { pocket: s.result! }))
      .toMatchObject({ kind: 'verified', unseeded: [BOB] });
  });

  it("a record copied in from the same table and round in another room isn't revealed", () => {
    freshRoom('room-A');
    buyInChips(AMY, 100);
    buyInChips(BOB, 100);
    const t = 'shared-table-id';
    const closingA = rouletteToClosing(t);
    const amyOnA = closingA.commits![AMY];
    // Room B: same table id, same round, the attacker copies Amy's record.
    freshRoom('room-B');
    tickAutoCroupier(t);
    writeMyBets(t, AMY, 1, [{ type: 'red', amount: 5 }]);
    const openB = readTableState(t)!;
    // …and room A's house commit, so everything but the room matches.
    const house = closingA.houseCommit!;
    writeMySeedRecord(t, AMY, { round: 1, house, commit: amyOnA });
    writeTableState(t, { ...openB, houseCommit: house, phase: 'closing', commits: { [AMY]: amyOnA } });
    playersLook(t, 'roulette', [AMY]);
    expect(readSeedRecord(t, AMY)?.seed).toBeUndefined();
  });

  it("the plaque follows the round's locked-in mode, not a mid-round switch", () => {
    const t = freshTable();
    expect(roundIsFair(t, 'roulette')).toBe(true); // no round yet: the setting
    writeCrapsFairnessPref(t, 'rng');
    tickAutoCroupier(t); // opens an RNG round
    expect(roundIsFair(t, 'roulette')).toBe(false);
    writeCrapsFairnessPref(t, 'multiparty');
    expect(roundIsFair(t, 'roulette')).toBe(false); // still this RNG round
  });

  it('a bettor who joins after "no more bets" is not a party', () => {
    const t = freshTable();
    const closing = rouletteToClosing(t);
    const late = 'player-Late';
    writeMySeedRecord(t, late, { round: 1, house: closing.houseCommit!, commit: 'f'.repeat(64) });
    expect(readTableState(t)?.commits?.[late]).toBeUndefined();
  });
});

describe('a Fair craps roll', () => {
  it('settles from the house and the bettors, and the dice verify', async () => {
    const t = freshTable();
    tickAutoStickman(t); // opens the come-out
    expect(readCrapsTableState(t)?.houseCommit).toBeTruthy();
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    writeMyCrapsBets(t, BOB, [{ type: 'field', amount: 5 }]);
    tickAutoStickman(t); // arms
    playersLook(t, 'craps');
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t); // closes (no seated shooter: the stickman throws)
    expect(Object.keys(readCrapsTableState(t)?.commits ?? {}).sort()).toEqual([AMY, BOB]);
    playersLook(t, 'craps');
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.fairness?.parties).toEqual(['house', AMY, BOB]);
    const v = await verifySettledRound('craps', t, s, { dice: s.dice! });
    expect(v.kind).toBe('verified');
  });

  it('a withheld reveal forfeits every bet on the felt, standing ones too', async () => {
    const t = freshTable();
    // Bob's pass line already travelled to a point of 6.
    writeCrapsTableState(t, {
      kind: 'craps', phase: 'settled', round: 1, point: 6, dice: [3, 3], result: 6,
      resultAt: T0, payouts: {}, phaseDeadline: T0,
    } as CrapsTableState);
    tickAutoStickman(t); // opens round 2 with the point on
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps', [BOB]);
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t); // the stickman throws; the settle waits on Bob
    await flush();
    expect(readCrapsTableState(t)?.phase).toBe('closing');
    const thrown = readDiceThrow(t);
    tickAutoStickman(t); // waiting still: no second throw
    await flush();
    expect(readDiceThrow(t)).toEqual(thrown);
    later(REVEAL_GRACE_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(readAllCrapsBets(t)[BOB]).toBeUndefined();
    expect(s.payouts?.[BOB]).toBeUndefined();
  });

  it('a window opened Fair settles Fair even if the owner switches to RNG mid-window', async () => {
    const t = freshTable();
    tickAutoStickman(t);
    expect(readCrapsTableState(t)?.fairMode).toBe('multiparty');
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    writeCrapsFairnessPref(t, 'rng');
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.fairness?.parties).toEqual(['house', AMY]);
  });

  it("the house's first ROLL on a fresh Fair table with bets down only opens the window", () => {
    const t = freshTable();
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    expect(pressManualRoll(t)).toMatch(/PRESS AGAIN/);
    expect(readCrapsTableState(t)?.phase).toBe('betting');
    playersLook(t, 'craps', [AMY]);
    expect(pressManualRoll(t)).toBeNull();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('closing');
    expect(Object.keys(s.commits ?? {})).toEqual([AMY]);
    expect(s.unseeded ?? []).toEqual([]);
  });

  it('craps voids a wager list rewritten after the close, clearing it like a forfeit', async () => {
    const t = freshTable();
    tickAutoStickman(t);
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    writeMyCrapsBets(t, BOB, [{ type: 'field', amount: 5 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps');
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    expect(Object.keys(readCrapsTableState(t)?.wagers ?? {}).sort()).toEqual([AMY, BOB]);
    playersLook(t, 'craps');
    writeMyCrapsBets(t, BOB, [{ type: 'anyseven', amount: 50 }]);
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.payouts?.[BOB]).toBeUndefined();
    expect(readAllCrapsBets(t)[BOB]).toBeUndefined();
  });

  it('erasing the house commit after the close still rolls Fair, by the frozen one', async () => {
    const t = freshTable();
    tickAutoStickman(t);
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    writeCrapsTableState(t, { ...readCrapsTableState(t)!, houseCommit: undefined });
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.voided).toBeUndefined();
    expect(s.fairness?.parties).toEqual(['house', AMY]);
  });

  it("a takeover stickman who doesn't hold the house seed voids the roll without throwing", async () => {
    const t = freshTable();
    tickAutoStickman(t);
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    // Another house member's page took the round over: it never had the seed.
    const closing = readCrapsTableState(t)!;
    const foreign = { ...closing, houseCommit: 'e'.repeat(64) };
    writeCrapsTableState(t, foreign);
    forgetMissingTables(new Set()); // and never saw the close
    stickmanThrows(t, foreign);
    await flush();
    expect(readDiceThrow(t)).toBeNull();
    expect(readCrapsTableState(t)).toMatchObject({ phase: 'settled', voided: true, dice: null });
  });

  it('settles only frozen bettors whose wager lists still match', () => {
    const a = [{ type: 'pass', amount: 10 }];
    const wagers = { [AMY]: wagerFingerprint(a), [BOB]: wagerFingerprint([{ type: 'field', amount: 5 }]) };
    const out = frozenWagers('t', { kind: 'roulette', round: 1, houseCommit: 'h', wagers } as never, { [AMY]: a, [BOB]: [{ type: 'anyseven', amount: 50 }], 'player-Late': a });
    expect(out).toEqual({ bets: { [AMY]: a }, voided: [BOB], omitted: ['player-Late'] });
    expect(frozenWagers('t', { kind: 'roulette', round: 1 } as never, { [BOB]: a })).toEqual({ bets: { [BOB]: a }, voided: [], omitted: [] });
  });

  it('a roll whose house seed is gone is void: no dice, every bet stands', async () => {
    const t = freshTable();
    tickAutoStickman(t);
    writeCrapsTableState(t, { ...readCrapsTableState(t)!, houseCommit: 'f'.repeat(64) });
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    writeMyCrapsBets(t, BOB, [{ type: 'field', amount: 5 }]); // lands after the close
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s).toMatchObject({ phase: 'settled', dice: null, voided: true, point: null });
    expect(readAllCrapsBets(t)[AMY]).toEqual([{ type: 'pass', amount: 10 }]);
    // Bob wasn't staked at the close, so his late list just rides (craps).
    expect(readAllCrapsBets(t)[BOB]).toEqual([{ type: 'field', amount: 5 }]);
  });

  it('a roll the house seed is gone for is void at the close, before any dice are thrown', async () => {
    const t = freshTable();
    tickAutoStickman(t);
    writeCrapsTableState(t, { ...readCrapsTableState(t)!, houseCommit: 'f'.repeat(64) });
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps', [AMY]);
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t); // closes, and voids at once
    await flush();
    expect(readCrapsTableState(t)).toMatchObject({ phase: 'settled', voided: true, dice: null });
    expect(readDiceThrow(t)).toBeNull();
  });

  it('a played round stamped void fails the state guard', () => {
    const t = freshTable();
    writeCrapsTableState(t, {
      kind: 'craps', phase: 'settled', round: 1, point: null, dice: [3, 4], result: 7,
      resultAt: T0, payouts: {}, voided: true,
    } as CrapsTableState);
    expect(readCrapsTableState(t)).toBeNull();
  });

  it('an RNG table skips the exchange and carries no transcript', async () => {
    const t = freshTable();
    writeCrapsFairnessPref(t, 'rng');
    tickAutoStickman(t);
    expect(readCrapsTableState(t)?.houseCommit).toBeUndefined();
    writeMyCrapsBets(t, AMY, [{ type: 'pass', amount: 10 }]);
    tickAutoStickman(t);
    playersLook(t, 'craps');
    expect(readSeedRecord(t, AMY)).toBeNull();
    later(CRAPS_BET_WINDOW_MS);
    tickAutoStickman(t);
    later(CRAPS_CLOSING_MS);
    tickAutoStickman(t);
    await flush();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('settled');
    expect(s.fairness).toBeUndefined();
  });
});
