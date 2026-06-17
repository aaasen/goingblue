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
const zeros = (n: number) => Array(n).fill(0);
const ones = (n: number) => Array(n).fill(255);

describe("generateToken", () => {
  it("produces a TOKEN_CHARS-long, valid token", () => {
    const t = generateToken(realBytes);
    expect(t).toHaveLength(TOKEN_CHARS);
    expect(isValidToken(t)).toBe(true);
  });

  it("only uses the Crockford alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const t = generateToken(realBytes);
      expect(t).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      expect(isValidToken(t)).toBe(true);
    }
  });

  it("is deterministic for a fixed RNG and round-trips", () => {
    const t = generateToken(fixedBytes(...zeros(10)));
    expect(t).toBe("0000000000000000"); // all-zero 80-bit value → 16 zero chars
    expect(isValidToken(t)).toBe(true);
  });

  it("encodes the all-ones 80-bit value", () => {
    const t = generateToken(fixedBytes(...ones(10)));
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
    expect(isValidToken("000000000000000")).toBe(false); // 15 chars
    expect(isValidToken(generateToken(realBytes) + "0")).toBe(false); // 17 chars
  });

  it("rejects characters outside the alphabet", () => {
    // 'U' is excluded from the Crockford alphabet (and isn't folded to anything on input).
    expect(isValidToken("U000000000000000")).toBe(false);
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

  it("formatToken groups in four blocks of four and re-normalizes cleanly", () => {
    const t = generateToken(realBytes);
    const formatted = formatToken(t);
    expect(formatted).toMatch(/^.{4}-.{4}-.{4}-.{4}$/);
    expect(normalizeToken(formatted)).toBe(t);
  });
});
