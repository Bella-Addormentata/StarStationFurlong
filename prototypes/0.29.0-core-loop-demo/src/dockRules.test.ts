/**
 * ⚓ #163 — the two-part docking adapter. Pins the pure layer every dock
 * surface decides through: the segment kind and its fold (a dock sits where a
 * gangway would), the wire (sanitizer, tombstone berth memory, the shared
 * record shapes), the parts ledger and mirror math, and dockRules — the
 * +DOCK steps, the re-dock rule the transit mirror applies, and the
 * compare-and-swap decisions for both ends of a DOCK / UNDOCK.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as THREE from 'three';
import {
  DOCK_HALF_LEN, CHAIN_PORTAL_MARGIN, ROOM_HALF,
  buildConnectorChain, buildDockPortStub, dockChain, foldChainEnd,
  isAllDockSegments, isDockChain, projectionPoseFromWall, setVestibuleLightState,
  type ConnectorSegment,
} from './adapter';
import {
  bindDoorsDoc, buildDoorPairing, buildDoorTombstone, readAllDoors,
  readAllDoorsFrom, writeDoorRecordTo,
} from './doorsDoc';
import { mirrorSegments, partForSegment } from './stationParts';
import {
  berthMemoryFrom, classifyDockPort, farDockPatch, farUndockPatch, findFarDoor,
  gangwayPartRefusal, isPortDoor, mirrorMayWrite, nextDockStep, redockRecord,
  type NearEnd,
} from './dockRules';

/** A pass in the real format roomIdFromSeed parses: base64(JSON{roomId}). */
const seedFor = (roomId: string, salt = ''): string =>
  btoa(JSON.stringify({ roomId, salt }));

const STATION = 'home-station';
const SHIP = 'module-ship';

const near: NearEnd = {
  roomId: SHIP,
  address: seedFor(SHIP),
  doorId: 'd:shipport',
  wall: 'x-',
  lateral: 1,
};

describe('dock segment — geometry', () => {
  it('a dock folds to the classic 3.0 m door-to-module gap', () => {
    const end = foldChainEnd(dockChain());
    expect(end.x).toBeCloseTo(0, 9);
    expect(end.yawRad).toBeCloseTo(0, 9);
    expect(end.z).toBeCloseTo(CHAIN_PORTAL_MARGIN * 2 + DOCK_HALF_LEN * 2, 9);
    expect(end.z).toBeCloseTo(3.0, 9);
  });

  it('the docked module sits straight out, ROOM_HALF past the tunnel', () => {
    const pose = projectionPoseFromWall('y-', 0, dockChain(), 'y+', 0);
    // y- faces −z: door face at z = −6, tunnel 3 m, module half ROOM_HALF.
    expect(pose.x).toBeCloseTo(0, 9);
    expect(pose.z).toBeCloseTo(-6 - 3.0 - ROOM_HALF, 6);
  });

  it('isDockChain is exactly two halves; a port stub or a mixed chain is not a dock', () => {
    expect(isDockChain(dockChain())).toBe(true);
    expect(isDockChain([{ kind: 'dock' }])).toBe(false);
    expect(isDockChain([{ kind: 'dock' }, { kind: 'dock' }, { kind: 'dock' }])).toBe(false);
    expect(isDockChain([{ kind: 'flex', bendDeg: 0 }, { kind: 'dock' }])).toBe(false);
    expect(isDockChain(undefined)).toBe(false);
    expect(isAllDockSegments([{ kind: 'dock' }])).toBe(true);
    expect(isAllDockSegments([{ kind: 'dock' }, { kind: 'ext', bays: 2 }])).toBe(false);
    expect(isAllDockSegments([])).toBe(false);
  });
});

describe('dock segment — the round tunnel', () => {
  const at = { wall: 'y-' as const, lateral: 0 };
  const halves = (g: THREE.Group) =>
    g.children.filter((c) => c.userData?.isConnectorPart && c.userData.kind === 'dock');

  it('a dock chain builds as a round tunnel: two halves meeting ring to ring, open', () => {
    const g = buildConnectorChain('d:a', dockChain(), at);
    expect(g.userData.isDockAdapter).toBe(true);
    expect(g.userData.isVestibule).toBe(true);
    expect(g.userData.doorId).toBe('d:a');
    const h = halves(g);
    expect(h.map((c) => c.userData.mating)).toEqual(['far', 'near']);
    expect(h.every((c) => c.userData.sealed === false)).toBe(true);
    // Halves start at the portal margin and abut — meshes agree with the fold.
    expect(h[0].position.z).toBeCloseTo(CHAIN_PORTAL_MARGIN, 9);
    expect(h[1].position.z).toBeCloseTo(CHAIN_PORTAL_MARGIN + DOCK_HALF_LEN, 9);
    // No rectangular gangway portals in a dock.
    expect(g.children.length).toBe(2);
  });

  it('a lone port is one sealed half, and the airlock light states still reach it', () => {
    const g = buildDockPortStub('d:a', at);
    expect(g.userData.isDockPortStub).toBe(true);
    const h = halves(g);
    expect(h.length).toBe(1);
    expect(h[0].userData.sealed).toBe(true);
    setVestibuleLightState(g, 'fault');
    const glows: THREE.Mesh[] = [];
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name === 'vestibuleGlow') glows.push(o as THREE.Mesh);
    });
    expect(glows.length).toBeGreaterThan(0);
    for (const m of glows) {
      expect((m.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xff1744);
    }
  });

  it('a gangway chain still builds with its portals', () => {
    const g = buildConnectorChain('d:a', [{ kind: 'ext', bays: 4, skin: 'solid' }], at);
    expect(g.userData.isDockAdapter).toBeUndefined();
    expect(g.children.length).toBe(3); // entry portal + extension + exit portal
  });
});

describe('dock — the wire', () => {
  it('the sanitizer keeps dock halves, dockedAt, and a tombstone\'s berth memory', () => {
    const doc = new Y.Doc();
    const doors = doc.getMap('doors');
    doors.set('d:dock', { ...buildDoorPairing(seedFor(STATION), { segments: dockChain(), transient: true, dockedAt: 1000 }) });
    doors.set('d:gone', buildDoorTombstone(seedFor(STATION), { farDoor: 'd:sp', farWall: 'x+', farLateral: 2, undockedAt: 2000 }));
    const read = readAllDoorsFrom(doc);
    const dock = read.get('d:dock');
    expect(dock?.paired && dock.segments).toEqual([{ kind: 'dock' }, { kind: 'dock' }]);
    expect(dock?.paired && dock.dockedAt).toBe(1000);
    expect(dock?.paired && dock.transient).toBe(true);
    const gone = read.get('d:gone');
    expect(!gone?.paired && gone?.dock).toEqual({ farDoor: 'd:sp', farWall: 'x+', farLateral: 2, undockedAt: 2000 });
  });

  it('junk memory and junk stamps are dropped, never fatal', () => {
    const doc = new Y.Doc();
    const doors = doc.getMap('doors');
    doors.set('d:a', { paired: false, retiredAddress: 'x', dock: { undockedAt: 'soon', farWall: 'up' } });
    doors.set('d:b', { paired: false, retiredAddress: 'x', dock: { undockedAt: 5, farDoor: 'no spaces allowed?', farLateral: 99 } });
    doors.set('d:c', { paired: true, connectedRoomAddress: 'x', dockedAt: -3, segments: [{ kind: 'dock' }, { kind: 'warp' }] });
    const read = readAllDoorsFrom(doc);
    const a = read.get('d:a');
    expect(a && !a.paired && a.dock).toBeUndefined();
    const b = read.get('d:b');
    // The stamp survives; the unacceptable id and out-of-range lateral do not.
    expect(b && !b.paired && b.dock).toEqual({ undockedAt: 5 });
    const c = read.get('d:c');
    expect(c?.paired && c.dockedAt).toBeUndefined();
    expect(c?.paired && c.segments).toBeUndefined(); // an unknown kind drops the chain
  });

  it('writeDoorRecordTo writes the exact shape the bound reader reads back', () => {
    const doc = new Y.Doc();
    bindDoorsDoc(doc);
    writeDoorRecordTo(doc, 'd:x', buildDoorPairing(seedFor(SHIP), { segments: dockChain(), transient: true, dockedAt: 7 }));
    const rec = readAllDoors().get('d:x');
    expect(rec?.paired && isDockChain(rec.segments)).toBe(true);
    expect(rec?.paired && rec.dockedAt).toBe(7);
  });
});

describe('dock — parts and mirror', () => {
  it('a dock half costs an ADAPTER part', () => {
    expect(partForSegment({ kind: 'dock' })).toBe('adapter');
    expect(partForSegment({ kind: 'flex' })).toBe('flex');
    expect(partForSegment({ kind: 'ext' })).toBe('ext');
  });

  it('a dock read from the far door is still a dock', () => {
    expect(mirrorSegments(dockChain())).toEqual([{ kind: 'dock' }, { kind: 'dock' }]);
    const mixed: ConnectorSegment[] = [{ kind: 'flex', bendDeg: 10, stretch: 0 }, { kind: 'dock' }];
    expect(mirrorSegments(mixed)).toEqual([{ kind: 'dock' }, { kind: 'flex', bendDeg: -10, stretch: 0 }]);
  });
});

describe('dockRules — classify', () => {
  it('docked / undocked / free / gangway', () => {
    const docked = buildDoorPairing(seedFor(STATION), { segments: dockChain(), transient: true });
    const c1 = classifyDockPort(docked);
    expect(c1.kind).toBe('docked');
    expect(c1.kind === 'docked' && c1.roomId).toBe(STATION);

    const undocked = buildDoorTombstone(seedFor(STATION), { undockedAt: 9 });
    const c2 = classifyDockPort(undocked);
    expect(c2.kind).toBe('undocked');
    expect(c2.kind === 'undocked' && c2.memory.undockedAt).toBe(9);

    expect(classifyDockPort(undefined).kind).toBe('free');
    // A plain tombstone (no memory) is a free port: there is no berth to return to.
    expect(classifyDockPort(buildDoorTombstone(seedFor(STATION))).kind).toBe('free');
    expect(classifyDockPort(buildDoorPairing(seedFor(STATION), { segments: [{ kind: 'ext', bays: 4 }] })).kind).toBe('gangway');
    expect(classifyDockPort(buildDoorPairing(seedFor(STATION))).kind).toBe('gangway');
  });

  it('a live dock counts as a port even when the policy map lags', () => {
    const docked = buildDoorPairing(seedFor(STATION), { segments: dockChain() });
    expect(isPortDoor(false, docked)).toBe(true);
    expect(isPortDoor(false, undefined)).toBe(false);
    expect(isPortDoor(true, undefined)).toBe(true);
  });
});

describe('dockRules — the +DOCK vestibule option', () => {
  it('first press fits this door\'s port, second stages the mating half', () => {
    expect(nextDockStep({ hasPort: false, record: undefined, staged: undefined })).toEqual({ kind: 'fit-port' });
    expect(nextDockStep({ hasPort: true, record: undefined, staged: undefined })).toEqual({ kind: 'stage-mate' });
    expect(nextDockStep({ hasPort: true, record: undefined, staged: dockChain() }).kind).toBe('refuse');
  });

  it('refuses over a gangway chain, a live gangway, and a live dock', () => {
    const ext: ConnectorSegment[] = [{ kind: 'ext', bays: 4 }];
    expect(nextDockStep({ hasPort: false, record: undefined, staged: ext }).kind).toBe('refuse');
    const gangway = buildDoorPairing(seedFor(STATION));
    expect(nextDockStep({ hasPort: false, record: gangway, staged: undefined }).kind).toBe('refuse');
    const dock = buildDoorPairing(seedFor(STATION), { segments: dockChain() });
    expect(nextDockStep({ hasPort: true, record: dock, staged: undefined }).kind).toBe('refuse');
  });

  it('an undocked port (tombstone) can stage a mate for a NEW connection', () => {
    const t = buildDoorTombstone(seedFor(STATION), { undockedAt: 1 });
    expect(nextDockStep({ hasPort: true, record: t, staged: undefined })).toEqual({ kind: 'stage-mate' });
  });

  it('gangway parts are refused on a port door only', () => {
    expect(gangwayPartRefusal(true)).toMatch(/dock port/);
    expect(gangwayPartRefusal(false)).toBeNull();
  });
});

describe('dockRules — undock memory and re-dock', () => {
  it('UNDOCK remembers the far door; DOCK rebuilds the same dock', () => {
    const live = buildDoorPairing(seedFor(STATION), {
      segments: dockChain(), farDoor: 'd:bay', farWall: 'y+', farLateral: -2, transient: true, dockedAt: 10,
    });
    const memory = berthMemoryFrom(live, 20);
    expect(memory).toEqual({ farDoor: 'd:bay', farWall: 'y+', farLateral: -2, undockedAt: 20 });
    const state = classifyDockPort(buildDoorTombstone(seedFor(STATION), memory));
    if (state.kind !== 'undocked') throw new Error('expected undocked');
    const again = redockRecord(state, 30);
    expect(again).toEqual({
      paired: true, connectedRoomAddress: seedFor(STATION), segments: dockChain(),
      farDoor: 'd:bay', farWall: 'y+', farLateral: -2, transient: true, dockedAt: 30,
    });
  });
});

describe('dockRules — the transit mirror', () => {
  const dep = { isDock: true, dockedAt: 50 };

  it('never over a live pairing; freely onto an empty door', () => {
    expect(mirrorMayWrite(buildDoorPairing(seedFor('elsewhere')), STATION, dep)).toBe(false);
    expect(mirrorMayWrite(undefined, STATION, dep)).toBe(true);
  });

  it('refuses a tombstone naming the departure room — matched by ROOM, not by seed string', () => {
    const t = buildDoorTombstone(seedFor(STATION, 'pass-A'));
    expect(mirrorMayWrite(t, STATION, { isDock: false })).toBe(false);
    // A different pass to the same module used to slip past the string check.
    const t2 = buildDoorTombstone(seedFor(STATION, 'pass-B'));
    expect(mirrorMayWrite(t2, STATION, { isDock: false })).toBe(false);
    // A tombstone for some other module does not block this one.
    expect(mirrorMayWrite(buildDoorTombstone(seedFor('other')), STATION, { isDock: false })).toBe(true);
  });

  it('a dock made after the undock re-docks; an older one is a stale berth', () => {
    const t = buildDoorTombstone(seedFor(STATION), { undockedAt: 40 });
    expect(mirrorMayWrite(t, STATION, { isDock: true, dockedAt: 50 })).toBe(true);
    expect(mirrorMayWrite(t, STATION, { isDock: true, dockedAt: 30 })).toBe(false);
    expect(mirrorMayWrite(t, STATION, { isDock: true })).toBe(false); // unstamped: stale
    expect(mirrorMayWrite(t, STATION, { isDock: false, dockedAt: 50 })).toBe(false); // not a dock
    // A plain tombstone (no memory — a closed berth) is never overridden.
    expect(mirrorMayWrite(buildDoorTombstone(seedFor(STATION)), STATION, { isDock: true, dockedAt: 99 })).toBe(false);
  });
});

describe('dockRules — the far end', () => {
  it('findFarDoor: the hint, else the far door pointing back through our door, else the only one', () => {
    const doors = new Map([
      ['d:1', buildDoorPairing(seedFor(SHIP), { farDoor: 'd:other' })],
      ['d:2', buildDoorPairing(seedFor(SHIP), { farDoor: near.doorId })],
      ['d:3', buildDoorPairing(seedFor('elsewhere'))],
    ]);
    expect(findFarDoor(doors, SHIP, near.doorId, 'd:hint')).toBe('d:hint');
    expect(findFarDoor(doors, SHIP, near.doorId)).toBe('d:2');
    const single = new Map([['d:9', buildDoorPairing(seedFor(SHIP))]]);
    expect(findFarDoor(single, SHIP, near.doorId)).toBe('d:9');
    // d:1 points at our room but names ANOTHER of our doors: that is a
    // different connection's end, so there is no answer — not a wrong one.
    expect(findFarDoor(new Map([...doors].filter(([id]) => id !== 'd:2')), SHIP, near.doorId)).toBeNull();
  });

  it('UNDOCK tombstones only a far record that is still ours — and never a newer dock', () => {
    const ours = buildDoorPairing(seedFor(SHIP), { segments: dockChain(), dockedAt: 10 });
    const w = farUndockPatch(ours, near, 20);
    expect(w.action).toBe('write');
    expect(w.action === 'write' && w.record).toEqual({
      paired: false,
      retiredAddress: near.address,
      dock: { farDoor: near.doorId, farWall: near.wall, farLateral: near.lateral, undockedAt: 20 },
    });
    expect(farUndockPatch(undefined, near, 20)).toEqual({ action: 'skip', reason: 'absent' });
    expect(farUndockPatch(buildDoorTombstone('x'), near, 20)).toEqual({ action: 'skip', reason: 'already' });
    expect(farUndockPatch(buildDoorPairing(seedFor('elsewhere')), near, 20)).toEqual({ action: 'skip', reason: 'not-ours' });
    // A quick undock→dock: the late undock write must not undo the newer dock.
    const newer = buildDoorPairing(seedFor(SHIP), { segments: dockChain(), dockedAt: 30 });
    expect(farUndockPatch(newer, near, 20)).toEqual({ action: 'skip', reason: 'newer-dock' });
  });

  it('DOCK writes a free or remembered berth, refuses occupied, closed and gone ones', () => {
    const want = {
      paired: true, connectedRoomAddress: near.address, segments: dockChain(), farDoor: near.doorId,
      farWall: near.wall, farLateral: near.lateral, transient: true, dockedAt: 40,
    };
    expect(farDockPatch(undefined, true, near, 40)).toEqual({ action: 'write', record: want });
    expect(farDockPatch(buildDoorTombstone(seedFor(SHIP), { undockedAt: 5 }), true, near, 40)).toEqual({ action: 'write', record: want });
    expect(farDockPatch(buildDoorTombstone(seedFor('someone'), { undockedAt: 5 }), true, near, 40).action).toBe('write');
    expect(farDockPatch(buildDoorTombstone(seedFor('someone')), true, near, 40).action).toBe('write');
    expect(farDockPatch(buildDoorPairing(seedFor(SHIP)), true, near, 40).action).toBe('write'); // already us
    expect(farDockPatch(buildDoorPairing(seedFor('someone')), true, near, 40)).toEqual({ action: 'refuse', reason: 'occupied' });
    expect(farDockPatch(buildDoorTombstone(seedFor(SHIP)), true, near, 40)).toEqual({ action: 'refuse', reason: 'closed' });
    expect(farDockPatch(undefined, false, near, 40)).toEqual({ action: 'refuse', reason: 'gone' });
  });
});
