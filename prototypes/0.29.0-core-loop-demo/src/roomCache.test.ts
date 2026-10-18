/**
 * 💾 The room cache's word on what it kept (#272 review round 5): a snapshot
 * of a visit the host never answered is cached — but not believed as the
 * room's state — and a synced one is. Walked with the posture probe the way a
 * retry of a failed first visit goes.
 */
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { cacheRowOf, snapshotUsable } from './roomCache';
import { buildRoomCapPayload, roomPostureProbe, type PostureSources } from './network/roomCap';

const card = { nodeId: 'host', ck: 'Y2s=', kxPk: 'ab', issuedAt: 100, sig: 'ff' };

describe('room cache snapshots and the posture probe', () => {
  it('a failed first visit is cached but not believed; the retry keeps the pass\'s cards usable', () => {
    // First visit by a private pass: every live route to the host fails. The
    // replica holds our own presence and nothing from the host; leaving
    // flushes it.
    const first = new Y.Doc();
    first.getMap('players').set('me', { x: 0 });
    const unsyncedRow = cacheRowOf(Y.encodeStateAsUpdate(first), false, false, 1000);
    expect(unsyncedRow).toMatchObject({ owned: false, synced: false, savedAt: 1000, bytes: unsyncedRow.update.byteLength });
    expect(snapshotUsable(unsyncedRow)).toBe(false);
    expect(snapshotUsable(undefined)).toBe(false);
    expect(snapshotUsable({})).toBe(false); // a row saved before the flag existed
    // The retry restores it: non-empty, so the join's state vector is real,
    // but its door documents are the defaults, which read public. The probe
    // believes only a usable snapshot (or the host's state), so the cap stays
    // UNKNOWN and the pass's cards keep working.
    const retry = new Y.Doc();
    Y.applyUpdate(retry, unsyncedRow.update);
    expect(retry.getMap('players').has('me')).toBe(true);
    const state = { docsBoundFor: 'r' as string | null, stateUsable: snapshotUsable(unsyncedRow), passagePublic: true };
    const src: PostureSources = {
      bundled: () => false,
      docsBoundFor: () => state.docsBoundFor,
      stateUsable: () => state.stateUsable,
      passagePublic: () => state.passagePublic,
    };
    const probe = roomPostureProbe(src);
    expect(probe('r')).toBeUndefined();
    expect(buildRoomCapPayload('k', false, probe('r'), 1, true, [card])).toMatchObject({ publicRoom: null, passPrivate: true, memberCards: [card] });
    // A visit where the host's state arrived is kept as usable: its doors speak.
    const syncedRow = cacheRowOf(Y.encodeStateAsUpdate(retry), false, true, 2000);
    expect(snapshotUsable(syncedRow)).toBe(true);
    state.stateUsable = snapshotUsable(syncedRow);
    state.passagePublic = false;
    expect(probe('r')).toBe(false);
    expect(buildRoomCapPayload('k', false, probe('r'), 2, true, [card])).toMatchObject({ publicRoom: false, passPrivate: true });
  });
});
