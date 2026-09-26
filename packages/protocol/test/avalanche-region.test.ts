import { describe, it, expect } from "vitest";
import { AVALANCHE_PIECES, NO_PIECES, piecesInArea } from "../src/index.js";
import { PIECE_INTERIORS, REGION_ANCHOR_COUNTS, REGION_CHAINS } from "../src/avalanche-region.gen.js";
import { planRegion, readRegion } from "../src/avalanche-codec/region.js";
import { Decoder, costBits, encode, type Decision } from "../src/avalanche-codec/rans.js";

function roundTrip(pieces: number[]): { decoded: number[]; bits: number } {
  const plan: Decision[] = [];
  planRegion(plan, pieces);
  const bits = plan.reduce((sum, [table, sym]) => sum + costBits(table, sym), 0);
  return { decoded: readRegion(new Decoder(encode(plan))), bits };
}

const ofCenter = (center: string) => AVALANCHE_PIECES.filter((p) => p.center === center).map((p) => p.id);

describe("region model", () => {
  it("covers every piece", () => {
    expect(PIECE_INTERIORS).toHaveLength(AVALANCHE_PIECES.length);
    expect(REGION_ANCHOR_COUNTS).toHaveLength(NO_PIECES + 1);
    expect(REGION_CHAINS).toHaveLength(AVALANCHE_PIECES.length);
  });

  it("places each interior point in its own piece and no other", () => {
    AVALANCHE_PIECES.forEach((p) => {
      const covering = AVALANCHE_PIECES.filter((q) => piecesInArea({ type: "MultiPolygon", coordinates: q.polygons }, q.center).includes(p.id));
      expect(covering.map((q) => q.id)).toEqual([p.id]);
    });
  });
});

describe("region coding", () => {
  it.each([
    ["Sea to Sky", [6, 27, 32, 67, 72, 76]],
    ["one piece", [13]],
    ["no pieces", []],
    ["a whole center", ofCenter("avalanche-canada")],
    ["a single-piece center", ofCenter("avalanche-quebec")],
    ["a set never seen", [0, 5, 85]],
  ])("round-trips %s", (_, pieces) => {
    expect(roundTrip(pieces).decoded).toEqual(pieces);
  });

  it("codes a familiar area in a few bits", () => {
    expect(roundTrip([6, 27, 32, 67, 72, 76]).bits).toBeLessThan(16);
  });

  it("refuses a set spanning centers", () => {
    const [quebec] = ofCenter("avalanche-quebec");
    expect(() => planRegion([], [0, quebec])).toThrow(/cannot follow/);
  });
});
