/**
 * 🚏 A route keeper's DOCK through the docking system (docking.ts
 * redockPortAnswer, keeper mode): the far berth is asked over an await, and
 * the rider carve-out that let the keeper ask may be gone by the answer; a
 * far write the station never acknowledged is taken back. And the keypad
 * keeps the route's port on its door while the route runs (removeDockPort).
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
import { bindDoorPolicy, readDoorPolicy, writeDoorPolicy } from './doorPolicy';
import { bindDoorsDoc, readDoor, writeDoorTombstone } from './doorsDoc';
import { bindShipDoc, writeFuelLevel } from './shipDoc';
import { finishShipRoute, startShipRoute, stopShipRoute, writeShipRoute, type RouteStop } from './shipRoute';

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

  // Copilot (PR 180, 24th review): a far write the station never
  // acknowledged may still land, and the route may never ask here again.
  it('takes back a far write the station never acknowledged, though this port is unchanged', async () => {
    docking.onFarDockWrite(async (req) => {
      asks.push(req);
      return req.kind === 'dock'
        ? ({ ok: false, reason: 'unreachable', unconfirmed: true } satisfies FarDockResult)
        : ({ ok: true, detail: 'written' } satisfies FarDockResult);
    });
    const answer = await docking.redockPortAnswer('north', { keeper: true });
    expect(answer).toMatchObject({ ok: false, reason: 'unreachable' });
    const port = classifyDockPort(readDoor('north'));
    expect(port.kind).toBe('undocked');
    // This side keeps its berth memory, so the keeper's retry asks afresh.
    expect(port.kind === 'undocked' && port.memory.undockedAt).toBe(1000);
    expect(asks.map((a) => a.kind)).toEqual(['dock', 'undock']);
    const [dock, undo] = asks;
    expect(undo).toMatchObject({
      farAddress: SEED_BERTH,
      farDoor: 'south',
      nearDoorId: 'north',
      onlyDockedAt: dock.kind === 'dock' ? dock.dockedAt : NaN,
    });
    expect(undo.kind === 'undock' && dock.kind === 'dock' && undo.undockedAt > dock.dockedAt).toBe(true);
  });

  it('asks nothing back of a station that could not be reached at all', async () => {
    docking.onFarDockWrite(async (req) => {
      asks.push(req);
      return { ok: false, reason: 'unreachable' } satisfies FarDockResult;
    });
    const answer = await docking.redockPortAnswer('north', { keeper: true });
    expect(answer).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    expect(asks.map((a) => a.kind)).toEqual(['dock']);
  });
});

describe("the route's port at the keypad", () => {
  const stop = (i: number): RouteStop => ({
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: 'planet-sovereign',
    orbitSlot: i,
    berth: { roomId: `room-${i}`, farDoor: 'x+', anyGate: true },
    waitSecs: 60,
  });
  let docking: DoorDockingPortSystem;

  beforeEach(() => {
    const doc = new Y.Doc();
    bindShipDoc(doc);
    bindDoorsDoc(doc);
    bindDoorPolicy(doc);
    // The route's port, undocked from a stop it has left (in flight).
    writeDoorPolicy('north', { passage: 'public', construction: 'owner', adapter: true });
    writeDoorTombstone('north', SEED_BERTH, { farDoor: 'south', farWall: 'y+', undockedAt: 1000 });
    writeDoorPolicy('east', { passage: 'public', construction: 'owner', adapter: true });
    docking = new DoorDockingPortSystem(new THREE.Group());
    expect(writeShipRoute({ stops: [stop(0), stop(1)], shape: 'backAndForth', shipPort: 'north' })).toBe(true);
    writeFuelLevel(100, 100);
  });

  // Copilot (PR 180): in flight the route's port is undocked, so the docked
  // refusal alone let the keypad take it off, and the ferry could dock
  // nowhere at its next stop.
  it('keeps the port on while the route runs, and lets it go once the route has ended', () => {
    const now = Date.now();
    expect(startShipRoute({ now, startStop: 0, pilot: 'person', fuel: 100, capacity: 100 })).not.toBeNull();
    expect(docking.removeDockPort('north')).toMatch(/the ship's route docks through this door/);
    expect(readDoorPolicy('north').adapter).toBe(true);
    expect(classifyDockPort(readDoor('north')).kind).toBe('undocked');
    // STOP pressed, the route still runs until it finishes.
    expect(stopShipRoute(now + 1000)).toBe(true);
    expect(docking.removeDockPort('north')).not.toBeNull();
    // Another door's port is not the route's.
    expect(docking.removeDockPort('east')).toBeNull();
    expect(readDoorPolicy('east').adapter).toBe(false);
    expect(finishShipRoute()).toBe(true);
    expect(docking.removeDockPort('north')).toBeNull();
    expect(readDoorPolicy('north').adapter).toBe(false);
  });
});
