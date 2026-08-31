import { describe, it, expect } from "vitest";
import {
  splitReply, reassembleReply, mergeParts, partLabel, PART_LABEL_CHARS,
  chunkLines, collectingChunks, type ReplyOracles,
} from "../src/parts.js";
import { maxCharsFor, partBodyChars, widePartBodyChars, MAX_MESSAGES, UNCAPPED_MAX_CHARS } from "../src/devices.js";
import { V4_HEADER_CHARS, v4Codec } from "../src/versions/v4.js";
import type { ForecastMessage } from "../src/model.js";
import v4Fixture from "./fixtures/v4.fixture.json";

const H = V4_HEADER_CHARS;
const headerCharsOf = () => H;
const round = (parts: string[]) => reassembleReply(parts.join("\n"), headerCharsOf);

// Labelled parts carry everything the merge needs in the text itself, so these tests answer no to
// both of the questions only a decoder can settle. The transport-split path, which is the one that
// asks them, gets oracles built from a real codec further down.
const labelled: ReplyOracles = { headerCharsOf, decodes: () => false, isHead: () => false };

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
  const merge = (a: string, b: string) => mergeParts(a, b, labelled);

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

  it("keeps a reply already held whole when a part of it is pasted again", () => {
    // How a collected reply is stored and reloaded: reassembled, with the labels gone. Pasting
    // any of its bubbles again must not drop it back to that one segment.
    expect(merge(whole, first)).toBe(whole);
    expect(merge(whole, second)).toBe(whole);
    expect(merge(whole, [first, second].join("\n"))).toBe(whole);
    // A part carrying a payload this reply doesn't hold still replaces, header or no header.
    const elsewhere = splitReply("AbCdEzyxwvutsrq", H, 8)[1];
    expect(merge(whole, elsewhere)).toBe(elsewhere);
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

  it("leaves SMS at whole concatenated segments", () => {
    expect(maxCharsFor("s", 1, H)).toBe(160);
    expect(maxCharsFor("s", 2, H)).toBe(320);
    expect(partBodyChars("s", H)).toBeNull();
  });

  it("gives inReach labelled parts, each one whole message", () => {
    // A part spends its label and a repeated header out of the same 160, so one message stays
    // the plain unlabelled reply and two carry 2 × 151 body characters against one's 155.
    expect(partBodyChars("g", H)).toBe(160 - PART_LABEL_CHARS - H);
    expect(maxCharsFor("g", 1, H)).toBe(160);
    expect(maxCharsFor("g", 2, H)).toBe(H + 2 * 151);
    expect(PART_LABEL_CHARS + H + partBodyChars("g", H)!).toBe(160);
  });

  it("gives ZOLEO labelled parts, each inside its 240-byte message", () => {
    // A concatenated reply would be reassembled and then truncated at 240 bytes (probe 15), so
    // more forecast can only reach a ZOLEO as separate messages, each one inside the cap alone.
    expect(partBodyChars("z", H)).toBe(240 - PART_LABEL_CHARS - H);
    expect(maxCharsFor("z", 1, H)).toBe(240);
    expect(maxCharsFor("z", 2, H)).toBe(H + 2 * 231);
    expect(PART_LABEL_CHARS + H + partBodyChars("z", H)!).toBe(240);
  });

  it("ignores the message count on a route with no budget to divide", () => {
    // Internet: an HTTP response isn't metered in characters, so there is no budget for `n:` to
    // split and no second message to ask for. The number stays the constant itself.
    expect(maxCharsFor("d", 1, H)).toBe(UNCAPPED_MAX_CHARS);
    expect(maxCharsFor("d", 4, H)).toBe(UNCAPPED_MAX_CHARS);
  });

  it("clamps a nonsense message count instead of rejecting it", () => {
    expect(maxCharsFor("i", 0, H)).toBe(maxCharsFor("i", 1, H));
    expect(maxCharsFor("i", -3, H)).toBe(maxCharsFor("i", 1, H));
    expect(maxCharsFor("i", 99, H)).toBe(maxCharsFor("i", MAX_MESSAGES, H));
  });
});

// Collecting a reply the SERVER never split — the recovery path for a transport that chunks
// messages some way we didn't predict. Every chunk size below is one our model of the satellite
// relay says is impossible, on purpose: this path is what a wrong model falls back to, so it must
// not contain one.
describe("a reply the transport broke up", () => {
  const d = v4Fixture.decoded as ForecastMessage;
  const req = v4Fixture.request;
  const ctx = () => ({
    model: 31 - Math.clz32(d.models_mask & -d.models_mask),
    vars_mask: d.vars_mask,
    lat: d.lat,
    lon: d.lon,
    start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
    mode: req.mode,
    utcOffsetHours: req.utcOffsetHours,
  });

  const encoded = v4Codec.encode(d, "base85");
  // A reader with two requests outstanding, which is what makes "a different reply" a case worth
  // having: both codes resolve, so both first messages are heads.
  const OTHER_CODE = (d.code + 1) % 128;
  const requested = new Set([d.code, OTHER_CODE]);
  // What the app wires in: reading a reply takes the codec, and knowing whether this reader asked
  // for it takes their request store.
  const oracles: ReplyOracles = {
    headerCharsOf,
    decodes: (reply) => {
      try { v4Codec.decode(reassembleReply(reply, headerCharsOf), ctx); return true; }
      catch { return false; }
    },
    isHead: (chunk) => {
      try { return requested.has(v4Codec.header(chunk).code); } catch { return false; }
    },
  };
  const merge = (a: string, b: string) => mergeParts(a, b, oracles);
  const collecting = (held: string) => collectingChunks(held, oracles);

  // Deliberately ragged, and four ways where the relay would give at most three.
  const chunkAt = (s: string, sizes: number[]): string[] => {
    const out: string[] = [];
    let at = 0;
    for (const size of sizes) { out.push(s.slice(at, at + size)); at += size; }
    if (at < s.length) out.push(s.slice(at));
    return out;
  };
  const chunks = chunkAt(encoded, [23, 41, 12]);

  it("splits the fixture into more pieces than any transport we've measured", () => {
    expect(chunks.length).toBe(4);
    expect(chunks.join("")).toBe(encoded);
  });

  it("collects the pieces in paste order and decodes on the last one", () => {
    let held = chunks[0];
    expect(collecting(held)).toBe(true);
    for (const chunk of chunks.slice(1, -1)) {
      held = merge(held, chunk);
      // Nothing to show yet: an incomplete body fails to decode exactly as corrupt text does.
      expect(oracles.decodes(held)).toBe(false);
      expect(collecting(held)).toBe(true);
    }
    held = merge(held, chunks[chunks.length - 1]);
    expect(v4Codec.decode(reassembleReply(held, headerCharsOf), ctx)).toEqual(v4Fixture.decoded);
    // Finished, so no longer a collection — which is what takes the boxes off the screen.
    expect(collecting(held)).toBe(false);
  });

  it("counts the messages pasted so far", () => {
    let held = chunks[0];
    for (const chunk of chunks.slice(1, -1)) held = merge(held, chunk);
    expect(chunkLines(held)).toEqual(chunks.slice(0, -1));
  });

  it("ignores a message already pasted, wherever it sits", () => {
    const held = merge(chunks[0], chunks[1]);
    expect(merge(held, chunks[1])).toBe(held);   // the one just added
    expect(merge(held, chunks[0])).toBe(held);   // the header, which is also a head
  });

  it("starts over on the first message of a different reply", () => {
    const otherHead = v4Codec
      .encode({ ...d, code: OTHER_CODE } as ForecastMessage, "base85").slice(0, 23);
    const held = merge(chunks[0], chunks[1]);
    // A head is only ever a first message, so it opens a collection rather than joining one.
    expect(oracles.isHead(otherHead)).toBe(true);
    expect(merge(held, otherHead)).toBe(otherHead);
  });

  it("takes on a first message meant for someone else rather than risk a real one", () => {
    // A header for a request this reader doesn't hold reads as an ordinary continuation and is
    // appended — the collection then never decodes and they have to clear it. That is the cheaper
    // of the two mistakes available here: the alternative test, "does this look like a header",
    // would reset a collection on roughly one continuation message in eighty-five, always the
    // same one, putting that forecast permanently out of reach. See mergeChunks.
    const strayHead = v4Codec
      .encode({ ...d, code: (d.code + 64) % 128 } as ForecastMessage, "base85").slice(0, 23);
    expect(oracles.isHead(strayHead)).toBe(false);
    expect(chunkLines(merge(chunks[0], strayHead))).toEqual([chunks[0], strayHead]);
  });

  it("won't start a collection from a message that isn't the first", () => {
    // A later chunk carries no header, so on its own it is simply an unreadable paste — the
    // reader is told so rather than invited to keep pasting into something that can never decode.
    expect(collecting(chunks[1])).toBe(false);
    expect(merge("", chunks[1])).toBe(chunks[1]);
  });

  it("takes a whole reply over a collection in progress", () => {
    expect(merge(merge(chunks[0], chunks[1]), encoded)).toBe(encoded);
  });

  it("keeps a reply already collected when one of its messages is pasted again", () => {
    // Once it decodes, the forecast is on screen and the messages are still in the reader's
    // inbox. Pasting one again must not drop the forecast back to that one piece.
    let held = chunks[0];
    for (const chunk of chunks.slice(1)) held = merge(held, chunk);
    for (const chunk of chunks) expect(merge(held, chunk)).toBe(held);
    // Including after a round trip through the cache, which stores it reassembled.
    const stored = reassembleReply(held, headerCharsOf);
    for (const chunk of chunks) expect(merge(stored, chunk)).toBe(stored);
  });

  it("does not rescue a reader who pastes out of order", () => {
    // The one thing this path asks of them, since nothing in the text says where a piece belongs.
    let held = chunks[0];
    for (const chunk of [chunks[2], chunks[1], chunks[3]]) held = merge(held, chunk);
    expect(oracles.decodes(held)).toBe(false);
    // And it stays collectable-looking, which is why clearing has to be reachable at any time.
    expect(collecting(held)).toBe(true);
  });
});

describe("a real message split in two", () => {
  const d = v4Fixture.decoded as ForecastMessage;
  const req = v4Fixture.request;
  const ctx = () => ({
    model: 31 - Math.clz32(d.models_mask & -d.models_mask),
    vars_mask: d.vars_mask,
    lat: d.lat,
    lon: d.lon,
    start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
    mode: req.mode,
    utcOffsetHours: req.utcOffsetHours,
  });

  const encoded = v4Codec.encode(d, "base32768");
  const parts = splitReply(encoded, H, widePartBodyChars(H));

  it("gives every part a bubble's worth of bytes and code units", () => {
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(140);
      expect(part.length).toBeLessThanOrEqual(70);
    }
  });

  it("decodes after reassembly, in any order", () => {
    expect(v4Codec.decode(round(parts), ctx)).toEqual(v4Fixture.decoded);
    expect(v4Codec.decode(round([...parts].reverse()), ctx)).toEqual(v4Fixture.decoded);
  });
});
