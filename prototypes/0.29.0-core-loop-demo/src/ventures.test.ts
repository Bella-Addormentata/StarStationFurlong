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
  ventureRecord,
  type VentureLedgerEntry,
} from './ventures';

const ATTACKER = 'AAAAattackerpub';
const OWNER = 'BBBBrealownerpub';
const HOUR = 60 * 60 * 1000;

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindVentures(doc);
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
  it('an honest refresh now lands where a planted stamp used to block it forever', () => {
    plant(link(8.64e15, { [ATTACKER]: 100 }));
    // The planted record is refused outright, so the room reads as unchartered
    // and writeVentureLink (not refresh) is the path back to a good state.
    expect(ventureRecord()).toBeNull();
    expect(refreshVentureLink(ledgerEntry(Date.now(), { [OWNER]: 100 }))).toBe(false);
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
