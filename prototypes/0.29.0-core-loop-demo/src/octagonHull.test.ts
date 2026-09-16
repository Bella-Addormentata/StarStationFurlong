import { describe, expect, it } from "vitest";
import { capDoorOpenings, doorOpeningsBySurface, type HullDoorOpening } from "./octagonHull";

describe("doorOpeningsBySurface", () => {
  const doors: HullDoorOpening[] = [
    { wall: "x-", lateral: -2, width: 2, height: 3 },
    { wall: "x+", lateral: 1, width: 2, height: 3 },
    { wall: "y-", lateral: -1, width: 2, height: 3 },
    { wall: "y+", lateral: 2, width: 2, height: 3 },
  ];

  it("maps x-axis narrow rooms to x wall strips", () => {
    const out = doorOpeningsBySurface("x", doors);
    expect(out["wall-neg"]?.map((o) => o.along)).toEqual([-2]);
    expect(out["wall-pos"]?.map((o) => o.along)).toEqual([1]);
  });

  it("maps z-axis narrow rooms to y wall strips", () => {
    const out = doorOpeningsBySurface("z", doors);
    expect(out["wall-neg"]?.map((o) => o.along)).toEqual([-1]);
    expect(out["wall-pos"]?.map((o) => o.along)).toEqual([2]);
  });
});

describe("capDoorOpenings", () => {
  it("maps/merges cap holes and clamps them inside cap width", () => {
    const out = capDoorOpenings(
      "x",
      [
        { wall: "y-", lateral: 0, width: 2, height: 3 },
        { wall: "y-", lateral: 0.8, width: 2, height: 2.5 },
        { wall: "y+", lateral: 2.9, width: 2, height: 3 },
        { wall: "x-", lateral: 0, width: 2, height: 3 },
      ],
      3,
      4,
    );
    expect(out.neg).toEqual([
      { lo: -1, hi: 1, top: 3 },
      { lo: 1, hi: 1.8, top: 2.5 },
    ]);
    expect(out.pos).toEqual([{ lo: 1.9, hi: 2.95, top: 3 }]);
  });

  it("clamps over-tall holes to stay below the cap top edge", () => {
    const out = capDoorOpenings(
      "z",
      [{ wall: "x-", lateral: 0, width: 2, height: 10 }],
      3,
      4,
    );
    expect(out.neg).toEqual([{ lo: -1, hi: 1, top: 3.95 }]);
    expect(out.pos).toEqual([]);
  });

  it("keeps taller and shorter overlaps as separate-height spans", () => {
    const out = capDoorOpenings(
      "x",
      [
        { wall: "y-", lateral: -0.2, width: 2, height: 2.4 },
        { wall: "y-", lateral: 0.6, width: 2, height: 3 },
      ],
      3,
      4,
    );
    expect(out.neg).toEqual([
      { lo: -1.2, hi: -0.4, top: 2.4 },
      { lo: -0.4, hi: 1.6, top: 3 },
    ]);
  });
});
