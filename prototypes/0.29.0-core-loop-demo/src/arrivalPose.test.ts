// shipArrival.ts tests: an arrival re-points a port whose tombstone holds an
// older pose of the station's berth door (a door moved along its wall keeps
// its room and its id, and the directory gives its pose as it is now).

import { describe, expect, it } from 'vitest';
import { classifyDockPort } from './dockRules';
import type { DockBerthMemory } from './doorsDoc';
import { planArrivalDock, type ArrivalPort } from './shipArrival';

const SEED = 'ssf://room#room=furlong-berth';

const undocked = (dock: DockBerthMemory): ArrivalPort['state'] =>
  classifyDockPort({ paired: false, retiredAddress: SEED, dock });

describe("an arrival at a berth whose door has moved", () => {
  it("rewrites the port's tombstone with the berth's pose as it is now", () => {
    const plan = planArrivalDock({
      station: { berth: { address: SEED, farDoor: 'south', farWall: 'y+', farLateral: 2 } },
      remembered: null,
      ports: [{ doorId: 'north', state: undocked({ farDoor: 'south', farWall: 'y+', farLateral: -1, undockedAt: 5000 }) }],
      now: 10,
    });
    expect(plan).toEqual({
      kind: 'dock', doorId: 'north', address: SEED,
      retarget: { undockedAt: 5001, farDoor: 'south', farWall: 'y+', farLateral: 2 },
    });
  });

  it('rewrites a tombstone that holds no pose when the berth gives one', () => {
    const plan = planArrivalDock({
      station: { berth: { address: SEED, farDoor: 'south', farWall: 'x-' } },
      remembered: null,
      ports: [{ doorId: 'north', state: undocked({ farDoor: 'south', undockedAt: 5000 }) }],
      now: 10,
    });
    expect(plan).toMatchObject({ kind: 'dock', retarget: { farDoor: 'south', farWall: 'x-' } });
  });

  it('docks the tombstone as it is while it holds the same pose', () => {
    const plan = planArrivalDock({
      station: { berth: { address: SEED, farDoor: 'south', farWall: 'y+', farLateral: 2 } },
      remembered: null,
      ports: [{ doorId: 'north', state: undocked({ farDoor: 'south', farWall: 'y+', farLateral: 2, undockedAt: 5000 }) }],
    });
    expect(plan).toEqual({ kind: 'dock', doorId: 'north', address: SEED, retarget: null });
  });
});
