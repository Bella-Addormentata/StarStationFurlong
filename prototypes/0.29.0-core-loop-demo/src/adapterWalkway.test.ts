/**
 * 🚪🔒 adapter — the walkway through a connection (airlock crossing): the
 * centreline the player walks must end exactly where foldChainEnd puts the
 * far door, follow each bend's arc, and be as long as the tube.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAIN_PORTAL_MARGIN,
  EXT_BAY_LEN,
  FLEX_REST_LEN,
  buildConnectorEndCap,
  connectorCentreline,
  foldChainEnd,
  headingAcrossConnector,
  walkwayBetween,
  type ConnectorSegment,
} from './adapter';

const BENT: ConnectorSegment[] = [
  { kind: 'ext', bays: 4 },
  { kind: 'flex', bendDeg: 45 },
  { kind: 'ext', bays: 6 },
  { kind: 'flex', bendDeg: -30, stretch: 0.2 },
];

describe('connectorCentreline', () => {
  it('runs a straight vestibule 3 m out along +Z', () => {
    const line = connectorCentreline(null);
    expect(line.length).toBeCloseTo(3, 9);
    expect(line.endYaw).toBe(0);
    for (const p of line.points) expect(p.x).toBeCloseTo(0, 9);
    expect(line.points[line.points.length - 1].z).toBeCloseTo(3, 9);
  });

  it('ends where foldChainEnd puts the far door, with its heading', () => {
    const line = connectorCentreline(BENT);
    const end = foldChainEnd(BENT);
    const tip = line.points[line.points.length - 1];
    expect(tip.x).toBeCloseTo(end.x, 6);
    expect(tip.z).toBeCloseTo(end.z, 6);
    expect(line.endYaw).toBeCloseTo(end.yawRad, 9);
  });

  it('is as long as the tube: margins, extensions and arcs', () => {
    const line = connectorCentreline(BENT);
    const expected =
      2 * CHAIN_PORTAL_MARGIN + 10 * EXT_BAY_LEN + FLEX_REST_LEN + (FLEX_REST_LEN + 0.2);
    expect(line.length).toBeCloseTo(expected, 9);
    expect(line.points[line.points.length - 1].s).toBeCloseTo(expected, 9);
  });

  it('follows a bend instead of cutting across it', () => {
    const chain: ConnectorSegment[] = [{ kind: 'flex', bendDeg: 60 }];
    const line = connectorCentreline(chain, 0.1);
    // Each step is short, and the walked distance matches the straight-line
    // steps (no corner cut).
    let walked = 0;
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1],
        b = line.points[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      expect(d).toBeLessThan(0.11);
      walked += d;
    }
    expect(walked).toBeCloseTo(line.length, 2);
  });
});

describe('walkwayBetween', () => {
  it('starts past `from` and ends exactly at `to`', () => {
    const line = connectorCentreline(BENT);
    const path = walkwayBetween(line, 1.1, line.length - 1.1);
    expect(path.length).toBeGreaterThan(5);
    expect(path[0].s).toBeGreaterThan(1.1);
    expect(path[path.length - 1].s).toBeCloseTo(line.length - 1.1, 9);
    for (let i = 1; i < path.length; i++) expect(path[i].s).toBeGreaterThan(path[i - 1].s);
  });

  it('interpolates the end point on the centreline', () => {
    const line = connectorCentreline(null);
    const path = walkwayBetween(line, 1.1, 1.9);
    expect(path[path.length - 1]).toMatchObject({ x: 0, s: 1.9 });
    expect(path[path.length - 1].z).toBeCloseTo(1.9, 9);
  });
});

describe('headingAcrossConnector', () => {
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

  it('looking out of a straight tube is looking into the far room', () => {
    // Out of a south door (yaw 0) into a north door (outward yaw π).
    expect(headingAcrossConnector(0, 0, 0, Math.PI)).toBeCloseTo(0, 9);
    // Out of an east door into a south door: the far room is turned.
    const east = Math.PI / 2;
    expect(wrap(headingAcrossConnector(east, east, 0, 0) - Math.PI)).toBeCloseTo(0, 9);
  });

  it('looking along the end of a bend is looking square into the far room', () => {
    const line = connectorCentreline(BENT);
    const out = 0.4,
      arr = -1.1;
    const h = headingAcrossConnector(out + line.endYaw, out, line.endYaw, arr);
    expect(wrap(h - (arr + Math.PI))).toBeCloseTo(0, 9);
  });

  it('keeps a look off to one side the same amount off', () => {
    const h = headingAcrossConnector(0.3 + 0.2, 0.3, 0, 2);
    expect(wrap(h - (2 + Math.PI + 0.2))).toBeCloseTo(0, 9);
  });
});

describe('buildConnectorEndCap', () => {
  it('stands the far hatch at the end of the tube, facing along it', () => {
    const end = foldChainEnd(BENT);
    const cap = buildConnectorEndCap(BENT, 'far');
    expect(Math.hypot(cap.position.x - end.x, cap.position.z - end.z)).toBeCloseTo(0.02, 6);
    expect(cap.rotation.y).toBeCloseTo(end.yawRad, 9);
  });

  it('puts the near hatch at the door face', () => {
    const cap = buildConnectorEndCap(BENT, 'near');
    expect(cap.position.z).toBeCloseTo(0.02, 9);
    expect(cap.position.x).toBe(0);
  });
});
