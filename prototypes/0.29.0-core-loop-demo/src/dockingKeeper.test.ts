/**
 * 🚏 A route keeper's DOCK through the docking system (docking.ts
 * redockPortAnswer, keeper mode): the far berth is asked over an await, and
 * the rider carve-out that let the keeper ask may be gone by the answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The docking system's module graph touches `window` and `document` as it
// loads: stub them before any import runs.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    __ssfRoomId: 'ship-room',
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
  };
  g.document = { getElementById: () => null };
});

import * as THREE from 'three';
import * as Y from 'yjs';
import { DoorDockingPortSystem } from './docking';
import type { FarDockRequest, FarDockResult } from './docking';
import { classifyDockPort } from './dockRules';
import { bindDoorPolicy, writeDoorPolicy } from './doorPolicy';
import { bindDoorsDoc, readDoor, writeDoorTombstone } from './doorsDoc';
import { bindShipDoc } from './shipDoc';

const SEED_BERTH = 'ssf://room#room=stop-berth';

describe("a keeper's DOCK and the rider carve-out", () => {
  let right = true;
  let asks: FarDockRequest[] = [];
  let docking: DoorDockingPortSystem;

  beforeEach(() => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindDoorPolicy(doc);
    // The route's port, undocked from the stop's berth. This rider may not
    // build here: only the carve-out lets the keeper dock it.
    writeDoorPolicy('north', { passage: 'public', construction: 'owner', adapter: true });
    writeDoorTombstone('north', SEED_BERTH, { farDoor: 'south', farWall: 'y+', undockedAt: 1000 });
    right = true;
    asks = [];
    docking = new DoorDockingPortSystem(new THREE.Group());
    docking.onOwnerCheck(() => false);
    docking.onRouteDockRight(() => right);
  });

  it('docks while the keeper still wants the dock when the berth answers', async () => {
    docking.onFarDockWrite(async (req) => {
      asks.push(req);
      return { ok: true, detail: 'written' } satisfies FarDockResult;
    });
    const answer = await docking.redockPortAnswer('north', { keeper: true });
    expect(answer.ok).toBe(true);
    expect(classifyDockPort(readDoor('north')).kind).toBe('docked');
    expect(asks.map((a) => a.kind)).toEqual(['dock']);
  });

  it('a route that stops wanting the dock while the berth is asked (SKIP, STOP, the guard band) leaves the port undocked and takes the far write back', async () => {
    docking.onFarDockWrite(async (req) => {
      asks.push(req);
      // SKIP pressed while the berth was asked: the keeper no longer wants it.
      if (req.kind === 'dock') right = false;
      return { ok: true, detail: 'written' } satisfies FarDockResult;
    });
    const answer = await docking.redockPortAnswer('north', { keeper: true });
    expect(answer.ok).toBe(false);
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    expect(asks.map((a) => a.kind)).toEqual(['dock', 'undock']);
    const [dock, undo] = asks;
    expect(undo).toMatchObject({ farDoor: 'south', onlyDockedAt: dock.kind === 'dock' ? dock.dockedAt : NaN });
  });
});
