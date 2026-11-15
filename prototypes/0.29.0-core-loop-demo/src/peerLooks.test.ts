import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLaneId, laneFromEnvelope, laneOfPeerId, looksByLane, outfitsByLane } from './peerLooks';
import { DEFAULT_LOOK } from './foxLook';
import { ADDRESSED_TICK_BYTES, unpackAddressedTick } from './network/protocol';

/** A `lane` envelope's payload as the node writes it: base64 of the JSON. */
const b64 = (text: string): string => btoa(text);
const laneEnvelope = (body: unknown) => ({ kind: 'lane', payload: b64(JSON.stringify(body)) });

const LANE_A = '00010a7f80abcdff';
const LANE_B = '0123456789abcdef';

describe('a lane id', () => {
  it('is 16 lowercase hex digits', () => {
    expect(isLaneId(LANE_A)).toBe(true);
    expect(isLaneId(LANE_B)).toBe(true);
    for (const bad of ['', '00010a7f80abcdf', '00010a7f80abcdff0', '00010A7F80ABCDFF', '00010a7f80abcdfg', ' 00010a7f80abcdf', 16, null, undefined, {}]) {
      expect(isLaneId(bad), String(bad)).toBe(false);
    }
  });

  it('is written as the page reads it off a tick (the node test names the same bytes)', () => {
    // ssf-p2p-node `a_lane_is_told_in_the_hex_a_tick_carries`: these 8 bytes
    // are told as "00010a7f80abcdff".
    const buf = new Uint8Array(ADDRESSED_TICK_BYTES);
    buf.set([0x00, 0x01, 0x0a, 0x7f, 0x80, 0xab, 0xcd, 0xff], 0);
    expect(unpackAddressedTick(buf).senderId).toBe(LANE_A);
  });
});

describe('a lane envelope', () => {
  it('tells the lane', () => {
    expect(laneFromEnvelope(laneEnvelope({ lane: LANE_A }))).toBe(LANE_A);
  });

  it('tells nothing when it is another kind, malformed, or names no well-formed lane', () => {
    expect(laneFromEnvelope({ kind: 'bridge', payload: b64(JSON.stringify({ lane: LANE_A })) })).toBeNull();
    expect(laneFromEnvelope({ kind: 'lane' })).toBeNull();
    expect(laneFromEnvelope({ kind: 'lane', payload: 42 })).toBeNull();
    expect(laneFromEnvelope({ kind: 'lane', payload: '%%%not base64%%%' })).toBeNull();
    expect(laneFromEnvelope({ kind: 'lane', payload: b64('not json') })).toBeNull();
    expect(laneFromEnvelope(laneEnvelope(null))).toBeNull();
    expect(laneFromEnvelope(laneEnvelope({}))).toBeNull();
    expect(laneFromEnvelope(laneEnvelope({ lane: LANE_A.toUpperCase() }))).toBeNull();
    expect(laneFromEnvelope(laneEnvelope({ lane: LANE_A.slice(1) }))).toBeNull();
    expect(laneFromEnvelope(laneEnvelope({ lane: 7 }))).toBeNull();
  });
});

describe('a remote rig id', () => {
  it('names the lane its ticks carry', () => {
    expect(laneOfPeerId(`peer-${LANE_A}`)).toBe(LANE_A);
  });

  it('names none for the slots of ticks that carry no lane, or any other id', () => {
    // main.ts's tick handler: a legacy un-addressed tick collapses into a
    // `peer-<n>` slot with no sender on the wire.
    for (const id of ['peer-0', 'peer-3', LANE_A, `player-${LANE_A}`, `peer-${LANE_A}0`, `peer-${LANE_A.toUpperCase()}`, '']) {
      expect(laneOfPeerId(id), id).toBeNull();
    }
  });
});

describe('the outfits by lane', () => {
  it('pairs each claimed lane with the outfit of the entry that claims it', () => {
    const found = outfitsByLane([
      ['player-1', { name: 'A', joinedAt: 1, outfitId: 'ember', lane: LANE_A }],
      ['player-2', { name: 'B', joinedAt: 2, outfitId: 'midnight', lane: LANE_B }],
    ]);
    expect([...found]).toEqual([
      [LANE_A, 'ember'],
      [LANE_B, 'midnight'],
    ]);
  });

  it('leaves out entries from older games, malformed entries and entries with no outfit', () => {
    const found = outfitsByLane([
      ['older', { name: 'O', joinedAt: 1, outfitId: 'ember' }],
      ['not an object', 'ember'],
      ['empty', null],
      ['bad lane', { outfitId: 'ember', lane: 'peer-1' }],
      ['upper lane', { outfitId: 'ember', lane: LANE_A.toUpperCase() }],
      ['no outfit', { lane: LANE_B }],
      ['number outfit', { lane: LANE_B, outfitId: 3 }],
    ]);
    expect(found.size).toBe(0);
  });

  it('matches no one when two or more entries claim one lane', () => {
    const found = outfitsByLane([
      ['player-1', { outfitId: 'ember', lane: LANE_A }],
      ['player-2', { outfitId: 'midnight', lane: LANE_A }],
      ['player-3', { outfitId: 'snowdrift', lane: LANE_A }],
      ['player-4', { outfitId: 'default', lane: LANE_B }],
    ]);
    expect([...found]).toEqual([[LANE_B, 'default']]);
  });

  it('keeps an outfit id it does not know, for the world to leave that fox tinted', () => {
    expect(outfitsByLane([['p', { outfitId: 'a-newer-games-outfit', lane: LANE_A }]]).get(LANE_A)).toBe('a-newer-games-outfit');
  });
});

describe('the looks by lane', () => {
  it('carries each entry\'s look, cleaned, beside its outfit; none from a game with no looks', () => {
    const found = looksByLane([
      ['p1', { outfitId: 'ember', lane: LANE_A, look: { fur: 3, cream: 1, eyes: 2, eyeColour: 4, ears: 1, size: 0 } }],
      ['p2', { outfitId: 'default', lane: LANE_B }],
    ]);
    expect(found.get(LANE_A)).toEqual({ outfitId: 'ember', look: { fur: 3, cream: 1, eyes: 2, eyeColour: 4, ears: 1, size: 0 } });
    expect(found.get(LANE_B)).toEqual({ outfitId: 'default', look: null });
  });

  it('cleans a look it cannot read into the default, and leaves out the same entries the outfits do', () => {
    const entries: [string, unknown][] = [
      ['p1', { outfitId: 'ember', lane: LANE_A, look: 'not a look' }],
      ['p2', { outfitId: 'ember', lane: LANE_B, look: { fur: 1 } }],
      ['p3', { outfitId: 'midnight', lane: LANE_B, look: { fur: 2 } }],
      ['p4', { lane: '0000000000000000', look: { fur: 1 } }],
    ];
    const found = looksByLane(entries);
    expect([...found.keys()]).toEqual([LANE_A]);
    expect(found.get(LANE_A)?.look).toEqual(DEFAULT_LOOK);
    expect([...outfitsByLane(entries).keys()]).toEqual([...found.keys()]);
  });
});

describe('the wiring', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
  const world = readFileSync(fileURLToPath(new URL('./world.ts', import.meta.url)), 'utf8');

  it('takes the lane from the session of the room and writes it into our players entry', () => {
    const reset = main.indexOf('  myTickLane = null;\n  const sync = new YjsSync({');
    expect(reset, 'a new session starts with no lane').toBeGreaterThan(0);
    const listener = main.indexOf('if (env.kind === "lane" && yjsSync === sync) {', reset);
    expect(listener, 'on this session\'s sync stream').toBeGreaterThan(reset);
    const told = main.slice(listener, listener + 300);
    expect(told).toContain('const lane = laneFromEnvelope(env);');
    expect(told).toContain('myTickLane = lane;');
    expect(told).toContain('updateLocalPlayerEntry();');
    expect(main).toContain('...(myTickLane ? { lane: myTickLane } : {}),');
  });

  it('reads the entries afresh at the join and on every change, and dresses the rigs again', () => {
    const bound = main.indexOf('const playersMap = sync.doc.getMap("players");');
    expect(main.indexOf('peerDress = looksByLane(playersMap.entries());\n  if (world) world.refreshPeerLooks();', bound)).toBeGreaterThan(bound);
    const observer = main.indexOf('playersMap.observe((_event) => {');
    expect(main.slice(observer, observer + 300)).toContain('peerDress = looksByLane(playersMap.entries());\n    if (world) world.refreshPeerLooks();');
  });

  it('dresses a rig in the outfit of the entry that claims its lane', () => {
    const resolver = main.indexOf('world.setPeerLooks((peerId) => {');
    expect(resolver).toBeGreaterThan(main.indexOf('world = new worldModule.World(scene);'));
    const body = main.slice(resolver, resolver + 300);
    expect(body).toContain('const lane = laneOfPeerId(peerId);');
    expect(body).toContain('peerDress.get(lane)');
    expect(body).toContain('const outfit = getOutfitById(found.outfitId) ?? null;');
  });

  it('dresses a new rig, and tints only a rig no entry claims', () => {
    const spawn = world.indexOf('const rig = new VoxelCharacter(this.scene);');
    const spawned = world.slice(spawn, world.indexOf('return;', spawn));
    expect(spawned).toContain('this.dressPeer(this.remotePlayers.get(id)!, id);');
    expect(spawned).not.toContain('applyPeerTint');
    const dress = world.indexOf('private dressPeer(avatar: RemoteAvatar, id: string): void {');
    const body = world.slice(dress, world.indexOf('\n  }\n', dress));
    expect(body).toContain('this.removePeerTint(avatar.rig);');
    expect(body).toContain('if (dress.outfit) avatar.rig.setOutfit(dress.outfit);');
    expect(body).toContain('avatar.rig.clearOutfit();\n      this.applyPeerTint(avatar.rig, id);');
  });
});
