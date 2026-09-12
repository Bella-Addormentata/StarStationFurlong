/**
 * 🏢 ventures — peer-written record hardening (#143)
 *
 * `ventureRecord()` is both the read boundary AND the ingest point: a hostile
 * peer writes the `venture` map directly, bypassing writeVentureLink /
 * refreshVentureLink entirely. These cases drive it the same way — direct map
 * writes, no helpers — so they exercise the path an attacker actually takes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindVentures,
  isVentureShareholder,
  refreshVentureLink,
  upsertVentureLedger,
  ventureLedger,
  ventureRecord,
  writeVentureLink,
  type VentureLedgerEntry,
} from './ventures';

/** vitest runs in node here, so the ledger's localStorage needs a shim. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const ATTACKER = 'AAAAattackerpub';
const OWNER = 'BBBBrealownerpub';
const HOUR = 60 * 60 * 1000;

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindVentures(doc);
  store.clear();
});

/** Write the venture map directly, as a modified peer would. */
function plant(rec: Record<string, unknown>): void {
  doc.getMap('venture').set('v', rec);
}

function link(snapshotAt: number, shares: Record<string, number>): Record<string, unknown> {
  return {
    id: 'v1', name: 'Acme', foundedAt: 0, founderPub: '', founderName: '',
    totalShares: 100, shares, holderNames: {},
    officeRoomId: 'module-office', snapshotAt,
  };
}

function ledgerEntry(capSeenAt: number, shares: Record<string, number>): VentureLedgerEntry {
  return {
    id: 'v1', name: 'Acme', officeRoomId: 'module-office',
    myShares: 100, totalShares: 100, lastSeenAt: Date.now(),
    shares, holderNames: {}, capSeenAt,
  };
}

describe('snapshotAt bounds (#143)', () => {
  it('refuses a record stamped far beyond our clock', () => {
    plant(link(8.64e15, { [ATTACKER]: 100 }));
    expect(ventureRecord()).toBeNull();
  });

  it('grants no owner-equivalence from a refused record', () => {
    plant(link(8.64e15, { [ATTACKER]: 100 }));
    // Without this, isLocalPlayerRoomOwner's third branch fires for the attacker.
    expect(isVentureShareholder(ATTACKER)).toBe(false);
  });

  it('accepts an ordinary stamp', () => {
    plant(link(Date.now() - 60_000, { [OWNER]: 100 }));
    expect(ventureRecord()?.shares).toEqual({ [OWNER]: 100 });
  });

  it('tolerates honest clock skew inside the window', () => {
    plant(link(Date.now() + HOUR, { [OWNER]: 100 }));
    expect(ventureRecord()).not.toBeNull();
  });

  it('refuses just outside the window', () => {
    plant(link(Date.now() + 7 * HOUR, { [OWNER]: 100 }));
    expect(ventureRecord()).toBeNull();
  });

  it('leaves an office record (no snapshotAt) unaffected by the bound', () => {
    plant({
      id: 'v1', name: 'Acme', foundedAt: 0, founderPub: '', founderName: '',
      totalShares: 100, shares: { [OWNER]: 100 }, holderNames: {},
    });
    expect(ventureRecord()).not.toBeNull();
    expect(ventureRecord()?.snapshotAt).toBeUndefined();
  });
});

describe('the refresh path is no longer pinnable (#143)', () => {
  it('a refused record reads as unchartered, so writeVentureLink is the repair path', () => {
    plant(link(8.64e15, { [ATTACKER]: 100 }));
    expect(ventureRecord()).toBeNull();
    // refresh cannot repair it — its own guard needs a readable link first...
    expect(refreshVentureLink(ledgerEntry(Date.now(), { [OWNER]: 100 }))).toBe(false);
    // ...but the room now reads as unchartered, so the write path is open.
    expect(writeVentureLink(ledgerEntry(Date.now(), { [OWNER]: 100 }))).toBe(true);
    expect(ventureRecord()?.shares).toEqual({ [OWNER]: 100 });
  });

  it('still refuses a genuinely older refresh against a valid link', () => {
    plant(link(Date.now(), { [OWNER]: 100 }));
    expect(refreshVentureLink(ledgerEntry(Date.now() - 60_000, { [ATTACKER]: 100 }))).toBe(false);
    expect(ventureRecord()?.shares).toEqual({ [OWNER]: 100 });
  });

  it('accepts a newer refresh against a valid link', () => {
    plant(link(Date.now() - 60_000, { [ATTACKER]: 100 }));
    expect(refreshVentureLink(ledgerEntry(Date.now(), { [OWNER]: 100 }))).toBe(true);
    expect(ventureRecord()?.shares).toEqual({ [OWNER]: 100 });
  });
});

describe('a ledger poisoned before the upgrade self-heals (#143)', () => {
  it('drops an impossible capSeenAt while keeping the venture', () => {
    upsertVentureLedger(ledgerEntry(8.64e15, { [ATTACKER]: 100 }));
    const [entry] = ventureLedger();
    expect(entry).toBeDefined();
    expect(entry.id).toBe('v1');            // the venture is real...
    expect(entry.capSeenAt).toBe(0);        // ...only its freshness claim was not
  });

  it('leaves an ordinary stamp untouched', () => {
    const now = Date.now();
    upsertVentureLedger(ledgerEntry(now, { [OWNER]: 100 }));
    expect(ventureLedger()[0].capSeenAt).toBe(now);
  });

  it('a zeroed stamp loses to any honest office visit', () => {
    upsertVentureLedger(ledgerEntry(8.64e15, { [ATTACKER]: 100 }));
    const prior = ventureLedger()[0];
    // This is the comparison syncVentureLedgerFromCurrentRoom makes at the
    // office (main.ts:2786). Before the fix, prior.capSeenAt beat every
    // Date.now() forever and the forged cap table was preserved.
    expect((prior.capSeenAt ?? 0) > Date.now()).toBe(false);
  });
});
