import { describe, it, expect } from "vitest";
import { multiMessageOffered, type DeviceCode } from "../src/devices.js";
import { ALWAYS_VARS, VAR, type Variable } from "../src/constants.js";

// One row per rule the builder's switch follows: [extra variables, offered on i/g/s/z/d].
// The always-on core rides along in every selection, as it does in a real request.
const ROWS: [string, Variable[], Record<DeviceCode, boolean>][] = [
  ["base",                 [],                        { i: true, g: false, s: false, z: false, d: false }],
  ["one cheap (precip)",   [VAR.precip],              { i: true, g: true,  s: true,  z: false, d: false }],
  ["one wind level",       [VAR.w600],                { i: true, g: true,  s: true,  z: false, d: false }],
  ["two cheap",            [VAR.precip, VAR.freeze],  { i: true, g: true,  s: true,  z: true,  d: false }],
  ["cheap + wind level",   [VAR.aqi, VAR.w600],       { i: true, g: true,  s: true,  z: true,  d: false }],
  ["two wind levels",      [VAR.w500, VAR.w600],      { i: true, g: true,  s: true,  z: true,  d: false }],
  ["clouds",               [VAR.clouds],              { i: true, g: true,  s: true,  z: true,  d: false }],
];

describe("multiMessageOffered", () => {
  for (const [name, extras, expected] of ROWS) {
    it(name, () => {
      const vars = new Set<Variable>([...ALWAYS_VARS, ...extras]);
      for (const code of Object.keys(expected) as DeviceCode[]) {
        expect(multiMessageOffered(code, vars), code).toBe(expected[code]);
      }
    });
  }
});
