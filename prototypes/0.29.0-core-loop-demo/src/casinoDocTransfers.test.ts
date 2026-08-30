// casinoDoc.ts chip-transfer integration tests: the WRITE path (writeChipTransfer)
// must debit and credit balances atomically, refuse over-drain / double-write /
// bad-own-signature / capacity-flood, and preserve the physical-conservation
// invariant (Σ bal:* unchanged by any successful transfer). The capacity /
// flood cap is counted only over signature-verified rows a hostile peer cannot
// mint, so a keyless spam of junk `xfer:` rows can no longer lock honest sends
// (the old counter over ALL rows was the denial-of-service). The READ path
// (readAllChipTransfers) must drop hostile / malformed rows so a peer that
// hijacks the map cannot crash BANK render or smuggle a mis-keyed record into
// the audit log.
//
// Uses a fresh in-memory Y.Doc bound via bindCasinoDoc — same wiring the main
// app hits at room-join, so what these tests exercise is what ships.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import {
  bindCasinoDoc,
  buyInChips,
  cashOutChips,
  readAllChipTransfers,
  readBought,
  readCageLedger,
  readCashed,
  readChips,
  writeChipTransfer,
} from './casinoDoc';
import {
  buildChipTransfer,
  MAX_CHIP_TRANSFERS,
  type ChipTransfer,
  type VerifyIdentityFn,
} from './casinoTransfers';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Deterministic sig stub (matches casinoTransfers.test.ts). The doc write
 *  path now verifies the signature it is handed (own-row hygiene + the
 *  capacity flood cap counts only verified rows), so `stubVerify` below is
 *  the matching check: a row signed by `signFor(pub)` verifies under that pub,
 *  and nothing else does. */
function stubSig(pub: string, bytes: Uint8Array): string {
  let acc = 0;
  for (const b of bytes) acc = (acc * 33 + b) >>> 0;
  return `sig(${pub}|${acc.toString(16)})`;
}
const signFor = (pub: string) => (bytes: Uint8Array): string => stubSig(pub, bytes);
/** The write path's injected Ed25519 check, stubbed to mirror stubSig. */
const stubVerify: VerifyIdentityFn = (pub, bytes, sig) => sig === stubSig(pub, bytes);

const ROOM = 'room-doc-test';
const ALICE_PUB = 'pub-alice';
const BOB_PUB = 'pub-bob';
const CAROL_PUB = 'pub-carol';
const MALLORY_PUB = 'pub-mallory';
const ALICE_PID = 'pid-alice';
const BOB_PID = 'pid-bob';
const CAROL_PID = 'pid-carol';
const MALLORY_PID = 'pid-mallory';

function newTransfer(
  fromPub: string,
  toPub: string,
  fromPid: string,
  toPid: string,
  amount: number,
  nonce: string,
  ts: number,
): ChipTransfer {
  return buildChipTransfer({
    roomId: ROOM,
    fromPub,
    toPub,
    fromPlayerId: fromPid,
    toPlayerId: toPid,
    amount,
    nonce,
    ts,
    sign: signFor(fromPub),
  });
}

beforeEach(() => {
  // Each test starts on a fresh Y.Doc so bindings don't leak.
  bindCasinoDoc(new Y.Doc());
});

// ── writeChipTransfer: happy path + conservation ─────────────────────────────

describe('casinoDoc · writeChipTransfer (happy path)', () => {
  it('atomically debits sender + credits recipient + writes xfer row', () => {
    buyInChips(ALICE_PID, 1000);
    expect(readChips(ALICE_PID)).toBe(1000);
    expect(readChips(BOB_PID)).toBe(0);

    const t = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 250, 'n1', 1_700_000_001_000);
    expect(writeChipTransfer(t, stubVerify)).toBe(true);

    expect(readChips(ALICE_PID)).toBe(750);
    expect(readChips(BOB_PID)).toBe(250);
    const rows = readAllChipTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(t.id);
    expect(rows[0].amount).toBe(250);
  });

  it('preserves Σ bal:* across every transfer (conservation invariant)', () => {
    buyInChips(ALICE_PID, 500);
    buyInChips(BOB_PID, 500);
    // Pre-transfer outstanding
    const ledger0 = readCageLedger();
    expect(ledger0.outstanding).toBe(1000);

    const ts0 = 1_700_000_010_000;
    expect(writeChipTransfer(newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'n2', ts0), stubVerify)).toBe(true);
    expect(writeChipTransfer(newTransfer(BOB_PUB, ALICE_PUB, BOB_PID, ALICE_PID, 40, 'n3', ts0 + 1), stubVerify)).toBe(true);
    expect(writeChipTransfer(newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 60, 'n4', ts0 + 2), stubVerify)).toBe(true);

    const ledger1 = readCageLedger();
    // Physical conservation — total outstanding is unchanged.
    expect(ledger1.outstanding).toBe(1000);
    // House net = 0 (no one cashed out, all chips still on the floor).
    expect(ledger1.houseNet).toBe(0);
    // Issued unchanged (transfers do not mint).
    expect(ledger1.issued).toBe(ledger0.issued);
    // Cashed unchanged.
    expect(ledger1.cashed).toBe(0);
  });

  it('does NOT alter bought/cashed (issuance is a cage concept, not a transfer one)', () => {
    buyInChips(ALICE_PID, 500);
    expect(readBought(ALICE_PID)).toBe(500);
    expect(readCashed(ALICE_PID)).toBe(0);

    const t = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 200, 'n5', 1_700_000_020_000);
    expect(writeChipTransfer(t, stubVerify)).toBe(true);

    // Cage counters unchanged — issuance still 500 for Alice, 0 cashed.
    expect(readBought(ALICE_PID)).toBe(500);
    expect(readCashed(ALICE_PID)).toBe(0);
    expect(readBought(BOB_PID)).toBe(0);
    expect(readCashed(BOB_PID)).toBe(0);
  });
});

// ── writeChipTransfer: refusals ──────────────────────────────────────────────

describe('casinoDoc · writeChipTransfer (refusals)', () => {
  it('refuses when the sender has no chips', () => {
    // No buyIn — Alice has 0.
    const t = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 1, 'n-empty', 1_700_000_030_000);
    expect(writeChipTransfer(t, stubVerify)).toBe(false);
    expect(readChips(BOB_PID)).toBe(0);
    expect(readAllChipTransfers()).toHaveLength(0);
  });

  it('refuses when the sender has SOME chips but not enough', () => {
    buyInChips(ALICE_PID, 50);
    const t = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 51, 'n-short', 1_700_000_031_000);
    expect(writeChipTransfer(t, stubVerify)).toBe(false);
    // Balances untouched — no half-write.
    expect(readChips(ALICE_PID)).toBe(50);
    expect(readChips(BOB_PID)).toBe(0);
    expect(readAllChipTransfers()).toHaveLength(0);
  });

  it('refuses a second write with the same (deterministic) id — double-send guard', () => {
    buyInChips(ALICE_PID, 500);
    const t = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'n-dupe', 1_700_000_032_000);
    expect(writeChipTransfer(t, stubVerify)).toBe(true);
    // Second identical write — same id ⇒ key collision ⇒ refused.
    expect(writeChipTransfer(t, stubVerify)).toBe(false);
    // The doc still shows one row; balances reflect one transfer.
    expect(readAllChipTransfers()).toHaveLength(1);
    expect(readChips(ALICE_PID)).toBe(400);
    expect(readChips(BOB_PID)).toBe(100);
  });

  it('refuses when the transfer object is malformed (guard on own writes)', () => {
    buyInChips(ALICE_PID, 500);
    // A "transfer" with a wrong id — the entry guard requires key===value.id.
    // Bypass the factory to construct a broken record.
    const good = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'n-mut', 1_700_000_033_000);
    const bad = { ...good, id: 't-0000000000000000000000000000000f' };
    expect(writeChipTransfer(bad as unknown as ChipTransfer, stubVerify)).toBe(false);
    // Balances untouched.
    expect(readChips(ALICE_PID)).toBe(500);
    expect(readChips(BOB_PID)).toBe(0);
  });

  it('refuses a transfer whose own signature does not verify (write-side hygiene)', () => {
    // The write path proves its own row genuine before planting it — a row we
    // could not verify ourselves is one the read seam would drop anyway, so we
    // never pollute the audit log (and never move chips) for it. The id derives
    // from the honest fields, so tampering only `sig` leaves the entry guard
    // satisfied and isolates the signature check.
    buyInChips(ALICE_PID, 500);
    const good = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'n-badsig', 1_700_000_034_000);
    const badSig = { ...good, sig: 'sig(tampered)' };
    expect(writeChipTransfer(badSig as ChipTransfer, stubVerify)).toBe(false);
    // Balances untouched — refused before the transact.
    expect(readChips(ALICE_PID)).toBe(500);
    expect(readChips(BOB_PID)).toBe(0);
    expect(readAllChipTransfers()).toHaveLength(0);
  });

  it('refuses any send once the room holds MAX_CHIP_TRANSFERS verified rows (GLOBAL cap)', () => {
    // The capacity cap is GLOBAL, not per-sender, and is the SAME number the
    // read seam materializes — so honest history can never outgrow the replay
    // window (a per-sender cap would let N senders push the total past it and
    // truncate real transfers out of the running-balance replay). Plant a full
    // window of GENUINE (correctly signed → verified) rows straight onto the
    // map, then a DIFFERENT, fully-funded sender holding zero rows of her own is
    // still refused: the room is at capacity for everyone.
    const doc = new Y.Doc();
    bindCasinoDoc(doc);
    const map = doc.getMap('casino');
    buyInChips(ALICE_PID, 1_000);
    for (let i = 0; i < MAX_CHIP_TRANSFERS; i++) {
      const genuine = newTransfer(BOB_PUB, CAROL_PUB, BOB_PID, CAROL_PID, 1, `full-${i}`, 1_700_300_000_000 + i);
      map.set(`xfer:${genuine.id}`, genuine);
    }
    const overflow = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'cap-over', 1_700_400_000_000);
    expect(writeChipTransfer(overflow, stubVerify)).toBe(false);
    // Refused at the gate — no half-write, no chips moved.
    expect(readChips(ALICE_PID)).toBe(1_000);
    expect(readChips(BOB_PID)).toBe(0);
  });

  it('does not count junk (unverified) rows toward the cap — honest send survives a full window of forgeries', () => {
    // A hostile peer plants a FULL window of entry-valid rows carrying FORGED
    // signatures (ids are derivable by anyone; the signature is the part they
    // cannot forge). The old counter over ALL rows treated this as a full room
    // and refused every send — the denial-of-service. Counting only VERIFIED
    // rows ignores the forgeries, so the honest send still settles.
    const doc = new Y.Doc();
    bindCasinoDoc(doc);
    const map = doc.getMap('casino');
    buyInChips(ALICE_PID, 1_000);
    for (let i = 0; i < MAX_CHIP_TRANSFERS; i++) {
      const genuine = newTransfer(MALLORY_PUB, CAROL_PUB, MALLORY_PID, CAROL_PID, 1, `junk-${i}`, 1_700_500_000_000 + i);
      const forged = { ...genuine, sig: 'sig(forged)' };
      map.set(`xfer:${forged.id}`, forged);
    }
    const honest = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'honest-1', 1_700_600_000_000);
    expect(writeChipTransfer(honest, stubVerify)).toBe(true);
    // The forged rows moved no chips (planted directly, never settled) and did
    // not count — the honest transfer debited/credited normally.
    expect(readChips(ALICE_PID)).toBe(900);
    expect(readChips(BOB_PID)).toBe(100);
  });

  it('fails OPEN under a junk flood larger than the verify-attempt budget (no DoS)', () => {
    // More entry-valid junk rows than the attempt budget (MAX_CHIP_TRANSFERS).
    // The scan bounds its verify work and, when the budget runs out, FAILS OPEN
    // rather than refusing — refusing there would hand the flooder the very DoS
    // this closes. Money-safety does not lean on this cap (the enforceable truth
    // is the balance transact + the read-seam replay); it is only send hygiene.
    const doc = new Y.Doc();
    bindCasinoDoc(doc);
    const map = doc.getMap('casino');
    buyInChips(ALICE_PID, 1_000);
    for (let i = 0; i < MAX_CHIP_TRANSFERS + 5; i++) {
      const genuine = newTransfer(MALLORY_PUB, CAROL_PUB, MALLORY_PID, CAROL_PID, 1, `flood-${i}`, 1_700_700_000_000 + i);
      const forged = { ...genuine, sig: 'sig(forged)' };
      map.set(`xfer:${forged.id}`, forged);
    }
    const honest = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 100, 'honest-2', 1_700_800_000_000);
    expect(writeChipTransfer(honest, stubVerify)).toBe(true);
    expect(readChips(ALICE_PID)).toBe(900);
    expect(readChips(BOB_PID)).toBe(100);
  });
});

// ── readAllChipTransfers: shape / hostile-peer defence ───────────────────────
//
// Bind a fresh doc for these tests and reach into its casino map directly so
// we can simulate a hostile peer's write (mismatched key, wrong shape, junk
// value). This mirrors the same "hostile posture" the treasuryDoc tests take.

describe('casinoDoc · readAllChipTransfers (hostile posture)', () => {
  it('drops xfer:* rows whose key does not match value.id (hijack defence)', () => {
    // Bind a doc we can also poke directly for the hostile-write half.
    const doc = new Y.Doc();
    bindCasinoDoc(doc);
    const map = doc.getMap('casino');
    // One WELL-FORMED write via the sanctioned path (Alice → Bob).
    // Buy in first so the writeChipTransfer's balance guard passes.
    buyInChips(ALICE_PID, 500);
    const good = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 200, 'n-key', 1_700_000_040_000);
    expect(writeChipTransfer(good, stubVerify)).toBe(true);
    // Now HOSTILE: plant an xfer:* row whose id-part-of-key does NOT match
    // value.id (a trusting reader would render this as a bogus transfer). The
    // key namespace is `xfer:<id>`; the guard strips the prefix and asserts
    // that inner id === value.id. Set BOTH parts to distinct plausible-looking
    // ids so neither an accidental match nor a shape pass slips through.
    map.set('xfer:t-00000000000000000000000000000abc', {
      ...good,
      id: 't-00000000000000000000000000000def', // key-id / value.id mismatch
    });
    // ALSO hostile: plant a totally malformed value.
    map.set('xfer:t-00000000000000000000000000000fed', 'not-a-transfer-object');
    // The reader must drop both hostile rows and return ONLY the honest one.
    const rows = readAllChipTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(good.id);
  });

  it('returns every well-formed row (caller sorts) — deterministic content', () => {
    buyInChips(ALICE_PID, 500);
    const a = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 50, 'sortA', 1_700_000_050_000);
    const b = newTransfer(ALICE_PUB, CAROL_PUB, ALICE_PID, CAROL_PID, 60, 'sortB', 1_700_000_051_000);
    expect(writeChipTransfer(a, stubVerify)).toBe(true);
    expect(writeChipTransfer(b, stubVerify)).toBe(true);
    const rows = readAllChipTransfers();
    // Content is deterministic (both rows survive); order is the caller's job.
    const amounts = rows.map((r) => r.amount).sort((x, y) => x - y);
    expect(amounts).toEqual([50, 60]);
  });
});

// ── End-to-end conservation across cage buy-in / transfer / cash-out ─────────

describe('casinoDoc · end-to-end conservation (buyIn → transfer → cashOut)', () => {
  it('houseNet returns to 0 after everything is cashed', () => {
    buyInChips(ALICE_PID, 200);
    // Alice pays Bob 80 in a room transfer.
    const t = newTransfer(ALICE_PUB, BOB_PUB, ALICE_PID, BOB_PID, 80, 'e2e-1', 1_700_000_060_000);
    expect(writeChipTransfer(t, stubVerify)).toBe(true);
    // Alice cashes out her remainder (120), Bob cashes out his (80).
    expect(cashOutChips(ALICE_PID, 120)).toBe(120);
    expect(cashOutChips(BOB_PID, 80)).toBe(80);
    const ledger = readCageLedger();
    expect(ledger.outstanding).toBe(0);
    expect(ledger.issued).toBe(200);
    expect(ledger.cashed).toBe(200);
    expect(ledger.houseNet).toBe(0);
  });
});
