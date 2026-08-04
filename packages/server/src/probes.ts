import { encode } from "base32768";

// Field probes for testing character-set transparency over the satellite SMS path. The working
// theory (from Twilio logs vs. observed delivery): Apple's satellite relay re-frames SMS as
// UTF-16 in 140-byte frames — 70 code units single-part, 67 per part when split — so a wide
// (non-GSM) alphabet could carry ~15 bits/char instead of base-85's 6.4. These probes measure
// whether wide characters survive the Twilio → carrier → satellite → Messages → copy/paste
// pipeline before any codec work builds on that assumption.
//
// Every payload is deterministic so a screenshot can be diffed against this file later, and
// each probe can be verified in the field by copying the reply back: "probe N <pasted text>"
// compares against the expected payload and answers PASS/PARTIAL/FAIL in plain GSM-safe ASCII.
// See PROBES.md at the repo root for the field procedure and expected bubble patterns.

// Deterministic byte stream (glibc-style LCG) so base32768 payloads are reproducible from the
// seed alone — no RNG or clock at runtime.
function lcgBytes(seed: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let x = seed >>> 0;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

// Position-coded wide text: length UTF-16 code units, all from the BMP. Every 10th position is
// a fullwidth digit/letter marker (０１…９ＡＢ…) so split boundaries can be read off a
// screenshot in the field; every other position i is U+4E00+i, so the exact split index is
// recoverable at home from any character. Fullwidth forms double as an NFKC canary: if any
// layer applies compatibility normalization, the markers collapse to plain ASCII digits.
function positionCoded(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    if (i % 10 === 0) {
      const m = i / 10;
      s += String.fromCharCode(m < 10 ? 0xff10 + m : 0xff21 + (m - 10));
    } else {
      s += String.fromCharCode(0x4e00 + i);
    }
  }
  return s;
}

// Characters most likely to be mangled somewhere in the pipeline, each preceded by an ASCII
// marker letter so a substitution is attributable by eye. Covers Twilio Smart Encoding targets
// (curly quotes, dashes, ellipsis, NBSP), NFC/NFD (precomposed é vs e+combining acute), NFKC
// (fullwidth markers live in probes 1-2; here the ﬁ ligature), a non-BMP surrogate pair (😀),
// and the GSM extension-table characters (€[]{}\^|~).
const RISKY =
  "A\u201CB\u201DC\u2018D\u2019E\u2014F\u2026G\u00E9He\u0301I\u{1F600}J\u20ACK[L]M{N}O\\P^Q|R~S\u00A0T\uFB01";

// Payload sizes are chosen around the 70-code-unit single-frame limit:
//   1: exactly 70 units — should arrive as ONE bubble via satellite if the frame theory holds.
//   2: exactly 140 units — expected to split (67+67+6 with concat headers, or 70+70 without).
//   3: 66 chars (123 LCG bytes) — broad base32768 repertoire sample, still one frame.
//   4: 45 chars (84 LCG bytes) — short enough that "probe 4 " + payload (53 units) copies back
//      in a single frame, giving a guaranteed in-field round-trip verdict.
//   5: risky characters above (42 units).
export const PROBES: Record<number, string> = {
  1: positionCoded(70),
  2: positionCoded(140),
  3: encode(lcgBytes(42, 123)),
  4: encode(lcgBytes(7, 84)),
  5: RISKY,
};

const USAGE =
  "Probes: 1=70 wide, 2=140 wide, 3=b32768, 4=b32768 short, 5=risky chars. " +
  "Send 'probe N', then verify with 'probe N <pasted reply>'.";

const cp = (s: string, i: number) => "U+" + s.codePointAt(i)!.toString(16).toUpperCase();

// Compare a copied-back payload against the expected probe text. Replies are plain ASCII within
// the GSM-7 basic set so the verdict itself always arrives intact and unsplit.
function verify(n: number, expected: string, got: string): string {
  if (got === expected) return `PASS probe ${n}: all ${expected.length} chars intact`;
  if (expected.startsWith(got) && got.length > 0)
    return `PARTIAL probe ${n}: first ${got.length}/${expected.length} chars intact (rest missing)`;
  let firstDiff = 0;
  while (firstDiff < got.length && firstDiff < expected.length && got[firstDiff] === expected[firstDiff]) {
    firstDiff++;
  }
  let diffs = 0;
  for (let i = 0; i < Math.max(got.length, expected.length); i++) {
    if (got[i] !== expected[i]) diffs++;
  }
  const at =
    firstDiff < expected.length && firstDiff < got.length
      ? `first @${firstDiff}: sent ${cp(expected, firstDiff)} got ${cp(got, firstDiff)}`
      : `length ${got.length} vs ${expected.length} expected`;
  return `FAIL probe ${n}: ${diffs} of ${expected.length} units differ, ${at}`;
}

// Handle a probe command, or return null if the message is not one. "probe" alone (or an unknown
// number) explains the probe set; "probe N" returns the payload; "probe N <text>" verifies.
export function probeReply(body: string): string | null {
  const match = body.trim().match(/^probe\s*(\d*)\s?([\s\S]*)$/i);
  if (!match) return null;
  const n = match[1] ? Number(match[1]) : NaN;
  const expected = PROBES[n];
  if (!expected) return USAGE;
  const rest = match[2].trim();
  return rest ? verify(n, expected, rest) : expected;
}
