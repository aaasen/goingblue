import { describe, it, expect } from "vitest";
import { subregionNames } from "../src/avalanche.js";

describe("subregionNames", () => {
  it("splits an area title on the bare hyphens between names", () => {
    expect(subregionNames("Brandywine-Garibaldi-Homathko-Sky Pilot-Spearhead-Tantalus"))
      .toEqual(["Brandywine", "Garibaldi", "Homathko", "Sky Pilot", "Spearhead", "Tantalus"]);
  });

  it("keeps spaced and known hyphens inside a name", () => {
    expect(subregionNames("Bow Valley-Highwood Pass-North 40-Spray - KLakes"))
      .toEqual(["Bow Valley", "Highwood Pass", "North 40", "Spray - KLakes"]);
    expect(subregionNames("Chic-Chocs")).toEqual(["Chic-Chocs"]);
  });
});
