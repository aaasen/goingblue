import { describe, it, expect } from "vitest";
import { multiMessageOffered, type DeviceCode } from "../src/devices.js";

// One row per rule the builder's switch follows: [group codes, wind levels, offered on i/g/s/z/d].
const ROWS: [string, string[], number[], Record<DeviceCode, boolean>][] = [
  ["base",                 [],         [],     { i: true, g: false, s: false, z: false, d: false }],
  ["one cheap (precip)",   ["p"],      [],     { i: true, g: true,  s: true,  z: false, d: false }],
  ["one wind level",       [],         [3],    { i: true, g: true,  s: true,  z: false, d: false }],
  ["two cheap",            ["p", "f"], [],     { i: true, g: true,  s: true,  z: true,  d: false }],
  ["cheap + wind level",   ["a"],      [3],    { i: true, g: true,  s: true,  z: true,  d: false }],
  ["two wind levels",      [],         [2, 3], { i: true, g: true,  s: true,  z: true,  d: false }],
  ["clouds",               ["c"],      [],     { i: true, g: true,  s: true,  z: true,  d: false }],
];

describe("multiMessageOffered", () => {
  for (const [name, codes, levels, expected] of ROWS) {
    it(name, () => {
      for (const code of Object.keys(expected) as DeviceCode[]) {
        expect(multiMessageOffered(code, codes, levels), code).toBe(expected[code]);
      }
    });
  }
});
