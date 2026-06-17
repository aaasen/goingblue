import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  generateToken,
  isValidToken,
  normalizeToken,
  formatToken,
  TOKEN_CHARS,
} from "../src/index.js";

// Real CSPRNG for the "looks random" tests (mirrors what the server passes in).
const realBytes = (n: number) => Uint8Array.from(randomBytes(n));
// Deterministic RNG helper: returns the given bytes so we can assert exact encodings.
const fixedBytes = (...bytes: number[]) => () => Uint8Array.from(bytes);

describe("generateToken", () => {
  it("produces a TOKEN_CHARS-long, valid token", () => {
    const t = generateToken(realBytes);
    expect(t).toHaveLength(TOKEN_CHARS);
    expect(isValidToken(t)).toBe(true);
  });

  it("only uses the Crockford data alphabet plus a check symbol", () => {
    for (let i = 0; i < 200; i++) {
      const t = generateToken(realBytes);
      expect(t.slice(0, TOKEN_CHARS - 1)).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/);
      expect(isValidToken(t)).toBe(true);
    }
  });

  it("is deterministic for a fixed RNG and round-trips", () => {
    const t = generateToken(fixedBytes(0, 0, 0, 0, 0, 0, 0, 0));
    expect(t).toBe("00000000000000"); // 13 data zeros + check symbol 0 (0 % 37 = 0)
    expect(isValidToken(t)).toBe(true);
  });

  it("encodes the all-ones 64-bit value within range", () => {
    const t = generateToken(fixedBytes(255, 255, 255, 255, 255, 255, 255, 255));
    expect(t).toHaveLength(TOKEN_CHARS);
    expect(isValidToken(t)).toBe(true);
  });

  it("yields distinct tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateToken(realBytes));
    expect(seen.size).toBe(1000);
  });

  it("rejects a short random source", () => {
    expect(() => generateToken(fixedBytes(1, 2, 3))).toThrow();
  });
});

describe("isValidToken", () => {
  it("rejects wrong lengths", () => {
    expect(isValidToken("")).toBe(false);
    expect(isValidToken("0000000000000")).toBe(false); // 13 chars, missing check
    expect(isValidToken(generateToken(realBytes) + "0")).toBe(false); // 15 chars
  });

  it("rejects characters outside the alphabet", () => {
    // 'U' is not a data symbol; place it in the data portion.
    expect(isValidToken("U000000000000")).toBe(false);
  });

  it("rejects a flipped data character (check symbol mismatch)", () => {
    const t = generateToken(realBytes);
    const flipped = (t[0] === "1" ? "2" : "1") + t.slice(1);
    expect(isValidToken(flipped)).toBe(false);
  });

  it("rejects a wrong check symbol", () => {
    const t = generateToken(realBytes);
    const wrongCheck = t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
    expect(isValidToken(wrongCheck)).toBe(false);
  });

  it("rejects a single-character transposition", () => {
    // Build a token whose first two data chars differ, then swap them.
    let t = generateToken(realBytes);
    while (t[0] === t[1]) t = generateToken(realBytes);
    const swapped = t[1] + t[0] + t.slice(2);
    expect(isValidToken(swapped)).toBe(false);
  });
});

describe("normalizeToken / isValidToken input tolerance", () => {
  it("accepts lowercase, grouping, and ambiguous letters", () => {
    const t = generateToken(realBytes);
    expect(isValidToken(t.toLowerCase())).toBe(true);
    expect(isValidToken(formatToken(t))).toBe(true);
    expect(isValidToken(`  ${formatToken(t).toLowerCase()}  `)).toBe(true);
  });

  it("folds O→0 and I/L→1", () => {
    expect(normalizeToken("OIL-oil")).toBe("011011");
  });

  it("formatToken groups in fours and re-normalizes cleanly", () => {
    const t = generateToken(realBytes);
    const formatted = formatToken(t);
    expect(formatted).toMatch(/^.{4}-.{4}-.{4}-.{2}$/);
    expect(normalizeToken(formatted)).toBe(t);
  });
});
