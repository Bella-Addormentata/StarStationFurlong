/**
 * 🛰️ defaultStation — the shipped welcome link and atlas agree, the bundle
 * is a reciprocal graph, the empty configuration ships nothing, and the
 * validator and the exporter drop what they should.
 */
import { describe, expect, it } from 'vitest';
import bundledAtlasJson from './defaultStation.atlas.json';
import {
  DEFAULT_STATION,
  atlasForBundle,
  defaultStationAtlas,
  defaultStationAtlasFor,
  parseBundledAtlas,
} from './defaultStation';
import { roomIdFromSeed } from './stationAtlas';
import type { AtlasEntry } from './stationAtlas';

describe('the empty configuration (WELCOME_ROOM_LINK = "")', () => {
  it('ships no station: nothing to seed, whatever the atlas file holds', () => {
    expect(roomIdFromSeed('')).toBe('');
    expect(defaultStationAtlasFor('', bundledAtlasJson)).toEqual([]);
    expect(defaultStationAtlasFor('not a link either', bundledAtlasJson)).toEqual([]);
    expect(atlasForBundle({}, '')).toEqual({});
  });
});

// The shipped configuration is either empty (covered above) or self-consistent.
describe.skipIf(!DEFAULT_STATION.welcomeRoomId)('the shipped default station', () => {
  it('has a welcome link that names a room the bundled atlas knows', () => {
    expect(DEFAULT_STATION.welcomeRoomId).toBe(roomIdFromSeed(DEFAULT_STATION.welcomeRoomLink));
    expect(DEFAULT_STATION.welcomeRoomId).toMatch(/^home-[0-9a-f]{12}$/);
    const atlas = defaultStationAtlas();
    const welcome = atlas.find((e) => e.roomId === DEFAULT_STATION.welcomeRoomId);
    expect(welcome).toBeDefined();
    expect(welcome!.name).toBe(DEFAULT_STATION.name);
    // The ONE seed in the bundle is the welcome room's, attached from the link.
    expect(welcome!.seed).toBe(DEFAULT_STATION.welcomeRoomLink);
    for (const e of atlas) if (e !== welcome) expect(e.seed).toBeUndefined();
  });

  it('is a v2 pass with a room key and iroh member hints (bridgeable from any machine)', () => {
    const seed = new URL(DEFAULT_STATION.welcomeRoomLink).searchParams.get('seed');
    expect(seed).toBeTruthy();
    const parsed = JSON.parse(atob(seed!));
    expect(parsed.v).toBe(2);
    expect(parsed.roomId).toBe(DEFAULT_STATION.welcomeRoomId);
    expect(typeof parsed.roomKeyB64).toBe('string');
    expect(parsed.memberHints?.[0]?.irohNodeId).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.memberHints[0].irohDirectAddrs.length).toBeGreaterThan(0);
  });

  it('ships a file the validator accepts whole', () => {
    const raw = bundledAtlasJson as Record<string, { doors: Record<string, unknown> }>;
    const parsed = parseBundledAtlas(bundledAtlasJson);
    expect(parsed.length).toBe(Object.keys(raw).length);
    for (const e of parsed) {
      expect(Object.keys(e.doors).length).toBe(Object.keys(raw[e.roomId].doors).length);
      expect(e.dims).toBeDefined();
    }
  });

  it('is a reciprocal graph: every pairing names a door that pairs straight back', () => {
    const atlas = defaultStationAtlas();
    const byId = new Map(atlas.map((e) => [e.roomId, e]));
    let pairings = 0;
    for (const e of atlas) {
      for (const [id, d] of Object.entries(e.doors)) {
        pairings++;
        const far = byId.get(d.targetRoomId);
        expect(far, `${e.roomId}/${id} → ${d.targetRoomId}`).toBeDefined();
        const back = far!.doors[d.farDoor ?? ''];
        expect(back, `${d.targetRoomId}/${d.farDoor} (far end of ${e.roomId}/${id})`).toBeDefined();
        expect(back.targetRoomId).toBe(e.roomId);
        expect(back.farDoor).toBe(id);
        expect(back.wall).toBe(d.farWall);
        expect(back.lateral).toBe(d.farLateral);
        expect(d.wall).toBeDefined();
      }
    }
    expect(pairings).toBeGreaterThan(0);
    expect(pairings % 2).toBe(0);
  });
});

describe('parseBundledAtlas', () => {
  const good = () => ({
    'module-a': {
      roomId: 'module-a',
      name: 'A',
      dims: { cols: 2, rows: 2 },
      doors: {
        'd:1': {
          targetRoomId: 'module-b', wall: 'y-', lateral: 0, farDoor: 'd:2', farWall: 'y+', farLateral: 0,
          segments: [{ kind: 'flex', bendDeg: -22.5 }, { kind: 'ext', bays: 4, skin: 'solid' }],
        },
      },
    },
  });

  it('accepts a well-formed entry and reads compass walls as axis labels', () => {
    const raw = good();
    raw['module-a'].doors['d:1'].wall = 'north';
    const [e] = parseBundledAtlas(raw);
    expect(e.doors['d:1'].wall).toBe('y-');
    expect(e.doors['d:1'].farWall).toBe('y+');
    expect(e.doors['d:1'].segments).toHaveLength(2);
    expect(e.dims).toEqual({ cols: 2, rows: 2 });
  });

  it('drops an entry whose key and roomId disagree, or whose dims leave the room envelope', () => {
    const mismatch = good();
    mismatch['module-a'].roomId = 'module-z';
    expect(parseBundledAtlas(mismatch)).toEqual([]);
    const huge = good();
    huge['module-a'].dims = { cols: 10_000, rows: 2 };
    expect(parseBundledAtlas(huge)).toEqual([]);
  });

  it('drops a door with an unknown wall, an out-of-range lateral or a nameless target — and keeps the rest', () => {
    const raw = good();
    const doors = raw['module-a'].doors as Record<string, unknown>;
    doors['d:badwall'] = { targetRoomId: 'module-b', wall: 'up' };
    doors['d:far'] = { targetRoomId: 'module-b', lateral: 1e9 };
    doors['d:none'] = { targetRoomId: '' };
    doors['d:segs'] = { targetRoomId: 'module-b', segments: [{ kind: 'warp' }] };
    const [e] = parseBundledAtlas(raw);
    expect(Object.keys(e.doors)).toEqual(['d:1']);
  });

  it('yields nothing for anything that is not a keyed object', () => {
    expect(parseBundledAtlas(null)).toEqual([]);
    expect(parseBundledAtlas([1, 2])).toEqual([]);
    expect(parseBundledAtlas('x')).toEqual([]);
  });
});

describe('atlasForBundle', () => {
  const now = Date.now();
  const door = (target: string, farDoor: string) => ({
    targetSeed: '', targetRoomId: target, wall: 'y-' as const, lateral: 0, farDoor, farWall: 'y+' as const, farLateral: 0,
  });

  it('strips seeds and stamps, drops doorless stubs, and round-trips through the validator', () => {
    const atlas: Record<string, AtlasEntry> = {
      'module-a': {
        roomId: 'module-a', name: 'A', seed: 'ssf://secret', dims: { cols: 2, rows: 2 },
        lastSeen: now, localSeenAt: now,
        doors: { 'd:1': { ...door('module-b', 'd:2'), targetSeed: 'ssf://door-secret' } },
      },
      'module-b': { roomId: 'module-b', name: 'Module', seed: 'ssf://stub', doors: {}, lastSeen: now },
    };
    const bundle = atlasForBundle(atlas, 'module-a');
    expect(Object.keys(bundle)).toEqual(['module-a']);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('lastSeen');
    expect(text).not.toContain('localSeenAt');
    const parsed = parseBundledAtlas(JSON.parse(text));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].doors['d:1']).toEqual({
      targetRoomId: 'module-b', wall: 'y-', lateral: 0, farDoor: 'd:2', farWall: 'y+', farLateral: 0,
    });
  });

  it('exports only the welcome room\'s connected component — walked both ways — never the rest of the atlas', () => {
    const atlas: Record<string, AtlasEntry> = {
      welcome: { roomId: 'welcome', name: 'W', doors: { 'd:1': door('hub', 'd:2') }, lastSeen: now },
      hub: { roomId: 'hub', name: 'H', doors: { 'd:2': door('welcome', 'd:1'), 'd:3': door('ring', 'd:4') }, lastSeen: now },
      // Reachable only through the hub's record (ring never recorded that pairing itself)…
      ring: { roomId: 'ring', name: 'R', doors: { 'd:9': door('spur', 'd:8') }, lastSeen: now },
      // …and spur only through ring's.
      spur: { roomId: 'spur', name: 'S', doors: { 'd:8': door('ring', 'd:9') }, lastSeen: now },
      // Another station this install once visited — not part of the export.
      elsewhere: { roomId: 'elsewhere', name: 'E', doors: { 'd:5': door('elsewhere-2', 'd:6') }, lastSeen: now },
      'elsewhere-2': { roomId: 'elsewhere-2', name: 'E2', doors: { 'd:6': door('elsewhere', 'd:5') }, lastSeen: now },
    };
    expect(Object.keys(atlasForBundle(atlas, 'welcome')).sort()).toEqual(['hub', 'ring', 'spur', 'welcome']);
    expect(Object.keys(atlasForBundle(atlas, 'elsewhere')).sort()).toEqual(['elsewhere', 'elsewhere-2']);
    expect(atlasForBundle(atlas, 'nowhere')).toEqual({});
  });
});
