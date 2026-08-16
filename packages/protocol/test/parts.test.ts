import { describe, it, expect } from "vitest";
import {
  splitReply, reassembleReply, mergeParts, partLabel, PART_LABEL_CHARS,
} from "../src/parts.js";
import { maxCharsFor, widePartBodyChars, MAX_MESSAGES } from "../src/devices.js";
import { V2_HEADER_CHARS, v2Codec } from "../src/versions/v2.js";
import type { ForecastMessage } from "../src/model.js";
import v2Fixture from "./fixtures/v2.fixture.json";

const H = V2_HEADER_CHARS;
const headerCharsOf = () => H;
const round = (parts: string[]) => reassembleReply(parts.join("\n"), headerCharsOf);

describe("splitting a reply", () => {
  const header = "AbCdE";
  const encoded = header + "0123456789";

  it("leaves a reply that fits one message alone and unlabelled", () => {
    expect(splitReply(encoded, H, 10)).toEqual([encoded]);
    expect(splitReply(encoded, H, 99)).toEqual([encoded]);
  });

  it("labels every part and repeats the header in each", () => {
    expect(splitReply(encoded, H, 4)).toEqual([
      "1/3 AbCdE0123",
      "2/3 AbCdE4567",
      "3/3 AbCdE89",
    ]);
  });

  it("round-trips through reassembly", () => {
    for (const per of [1, 2, 3, 4, 7, 9, 10]) {
      expect(round(splitReply(encoded, H, per)), `${per} per part`).toBe(encoded);
    }
  });

  it("spends exactly PART_LABEL_CHARS on the label", () => {
    expect(partLabel(1, 2).length).toBe(PART_LABEL_CHARS);
    expect(partLabel(9, 9).length).toBe(PART_LABEL_CHARS);
  });
});

describe("reassembling a paste", () => {
  const parts = splitReply("AbCdE0123456789", H, 4);

  it("passes an unlabelled single message straight through", () => {
    expect(reassembleReply("AbCdE0123456789", headerCharsOf)).toBe("AbCdE0123456789");
  });

  it("ignores whitespace, however the parts were pasted", () => {
    expect(round(parts)).toBe("AbCdE0123456789");
    expect(reassembleReply(parts.join(" "), headerCharsOf)).toBe("AbCdE0123456789");
    expect(reassembleReply(`  ${parts.join("\n\n  ")}\n`, headerCharsOf)).toBe("AbCdE0123456789");
  });

  it("accepts parts in any order — arrival order never has to be trusted", () => {
    expect(round([...parts].reverse())).toBe("AbCdE0123456789");
    expect(round([parts[1], parts[2], parts[0]])).toBe("AbCdE0123456789");
  });

  it("names the message that is missing", () => {
    expect(() => round([parts[0], parts[2]])).toThrow(/Missing message 2 of 3/);
    expect(() => round([parts[1]])).toThrow(/Missing messages 1, 3 of 3/);
  });

  it("rejects parts from different forecasts", () => {
    const other = splitReply("ZzZzZ9876543210", H, 4);
    expect(() => round([parts[0], other[1], parts[2]])).toThrow(/different forecast/);
    // Disagreeing part counts are caught before anything is stripped.
    expect(() => round([parts[0], splitReply("AbCdE01234", H, 4)[1]])).toThrow(/different forecasts/);
  });

  it("rejects the same part twice and stray text", () => {
    expect(() => round([parts[0], parts[0]])).toThrow(/pasted twice/);
    expect(() => reassembleReply(`junk ${parts.join(" ")}`, headerCharsOf))
      .toThrow(/isn't part of a numbered message/);
  });
});

// Collecting a reply one message at a time, which is how a reader actually receives it: the
// second bubble arrives after they have already pasted the first.
describe("merging a paste into what is already there", () => {
  const whole = "AbCdE0123456789";
  const [first, second] = splitReply(whole, H, 8);
  const merge = (a: string, b: string) => mergeParts(a, b, headerCharsOf);

  it("appends the other part of the same reply, in either arrival order", () => {
    expect(reassembleReply(merge(first, second), headerCharsOf)).toBe(whole);
    expect(reassembleReply(merge(second, first), headerCharsOf)).toBe(whole);
  });

  it("collects a three-part reply a message at a time", () => {
    const parts = splitReply(whole, H, 4);
    let held = parts[2];
    held = merge(held, parts[0]);
    expect(() => reassembleReply(held, headerCharsOf)).toThrow(/Missing message 2 of 3/);
    held = merge(held, parts[1]);
    expect(reassembleReply(held, headerCharsOf)).toBe(whole);
  });

  it("re-pasting a part replaces it rather than doubling it", () => {
    expect(merge(first, first)).toBe(first);
    expect(reassembleReply(merge(merge(first, second), second), headerCharsOf)).toBe(whole);
  });

  it("starts fresh on anything that isn't the rest of this reply", () => {
    const other = splitReply("ZzZzZ9876543210", H, 8);
    expect(merge(first, other[1])).toBe(other[1]);            // different forecast
    expect(merge(first, splitReply(whole, H, 4)[1])).toBe(splitReply(whole, H, 4)[1]); // different count
    expect(merge(first, "AbCdEwholeReply")).toBe("AbCdEwholeReply");  // an unlabelled reply
    expect(merge("", second)).toBe(second);                   // nothing held yet
    expect(merge("AbCdEwholeReply", second)).toBe(second);    // held reply wasn't multi-part
  });

  it("leaves the merged text readable by the same reassembly", () => {
    const held = merge(first, second);
    expect(held.startsWith("1/2 ")).toBe(true);
    expect(held.split("\n")).toEqual([first, second]);
  });
});

// The arithmetic that decides how much forecast a reader gets. A labelled part spends 4 characters
// on its label and repeats the 5-character header, so it carries less than an unlabelled single
// message — splitting has to earn its keep, and it does.
describe("the multi-message budget", () => {
  it("fits a labelled part in one bubble", () => {
    const body = widePartBodyChars(H);
    expect(body).toBe(43);
    expect(PART_LABEL_CHARS + H + body * 3).toBeLessThanOrEqual(140); // UTF-8 bytes
    expect(PART_LABEL_CHARS + H + body).toBeLessThanOrEqual(70);      // UTF-16 code units
  });

  it("splits at one character more", () => {
    expect(PART_LABEL_CHARS + H + (widePartBodyChars(H) + 1) * 3).toBeGreaterThan(140);
  });

  it("buys more forecast than one message, and more than a full SMS", () => {
    const one = maxCharsFor("i", 1, H) - H;   // body characters
    const two = maxCharsFor("i", 2, H) - H;
    expect(one).toBe(45);
    expect(two).toBe(86);
    expect(two * 15).toBeGreaterThan(160 * Math.log2(85)); // 1290 bits vs a 160-char SMS's 1025
  });

  it("leaves every other device at whole SMS segments", () => {
    for (const code of ["s", "z", "d", "g"] as const) {
      expect(maxCharsFor(code, 1, H)).toBe(160);
      expect(maxCharsFor(code, 2, H)).toBe(320);
    }
  });

  it("clamps a nonsense message count instead of rejecting it", () => {
    expect(maxCharsFor("i", 0, H)).toBe(maxCharsFor("i", 1, H));
    expect(maxCharsFor("i", -3, H)).toBe(maxCharsFor("i", 1, H));
    expect(maxCharsFor("i", 99, H)).toBe(maxCharsFor("i", MAX_MESSAGES, H));
  });
});

describe("a real message split in two", () => {
  const d = v2Fixture.decoded as ForecastMessage;
  const req = v2Fixture.request;
  const ctx = () => ({
    model: 31 - Math.clz32(d.models_mask & -d.models_mask),
    vars_mask: d.vars_mask,
    lat: d.lat,
    lon: d.lon,
    start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
    mode: req.mode,
    utcOffsetHours: req.utcOffsetHours,
  });

  const encoded = v2Codec.encode(d, "base32768");
  const parts = splitReply(encoded, H, widePartBodyChars(H));

  it("gives every part a bubble's worth of bytes and code units", () => {
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(140);
      expect(part.length).toBeLessThanOrEqual(70);
    }
  });

  it("decodes after reassembly, in any order", () => {
    expect(v2Codec.decode(round(parts), ctx)).toEqual(v2Fixture.decoded);
    expect(v2Codec.decode(round([...parts].reverse()), ctx)).toEqual(v2Fixture.decoded);
  });
});
