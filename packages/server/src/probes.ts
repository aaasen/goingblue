import { encode } from "base32768";
import { ALPHABET } from "@weather/protocol";

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
//
// Probes 15-17 (round 4) ask the same kind of question of ZOLEO, where the unknown is length
// rather than repertoire. A ZOLEO relays through a paired phone and picks its own route: with
// cell or WiFi the app goes over the internet, and only without one does it go over Iridium. A
// 240-character message observed on the internet route therefore measures nothing about the
// satellite one, which is the route that matters — see the field procedure in PROBES.md, where
// every ZOLEO probe is sent twice and the difference between the runs is the whole result.
//
// Probes 13-14 (round 3) ask a different question of a different route. Rounds 1-2 settled the
// iPhone relay, whose pipe is wide enough for base32768; the SMS route is capped instead by the
// septet — 160 GSM-7 characters per segment. The protocol alphabet is the intersection of GSM-7
// basic and printable ASCII (85 characters) because one alphabet had to serve inReach too. Now
// that the route picks the alphabet, the SMS route could also spend the 39 characters of GSM-7
// basic that are NOT ASCII: still one septet each, so still 160 to a segment, but base-124
// instead of base-85 — 8.5% more bits in the same message. These probes test whether that holds
// end to end, which needs two things that are not the same thing: that all 39 characters arrive
// unmangled (probe 13), and that a full 160-character message containing them still leaves as
// ONE segment rather than being upgraded to UCS-2, which would cut the message to 70 (probe 14).

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

// Random characters from a contiguous Unicode block, one LCG byte per char. Used for the
// single-block capacity probes: same entropy shape as base32768 output but with total block
// locality, which is the axis that separated probe 1 (fit) from probe 3 (split) in the field.
function blockRandom(bytes: Uint8Array, first: number, size: number): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(first + (b % size));
  return s;
}

// Random CJK needs more than 8 bits per char (20992-char block), so consume two LCG bytes each.
function cjkRandom(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode(0x4e00 + (((bytes[i] << 8) | bytes[i + 1]) % 20992));
  }
  return s;
}

// The 39 characters of the GSM-7 basic table that are not ASCII, in table order (0x01…0x7F).
// Each is a single septet, so on SMS they cost exactly what an ASCII character costs; they are
// the whole prize of a base-124 SMS alphabet, and the whole reason it can't be the inReach one.
export const GSM_EXTRA = "£¥èéùìòÇØøÅåΔΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà";

// One distinct ASCII marker per GSM_EXTRA character — A–Z then a–m is exactly 39.
const MARKERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";

// Probe 13: every non-ASCII GSM-7 character, each preceded by its marker so a substitution is
// attributable by eye on a screenshot — probe 5's convention, extended to the whole repertoire.
//
// The tail is the sharpest question in the set. Three GSM-7 characters sit at septet positions
// that ASCII gives to characters the protocol alphabet already spends — 0x24 ¤ vs `$`, 0x40 ¡ vs
// `@`, 0x5F § vs `_` — so a layer that confuses the GSM table with ASCII or Latin-1 substitutes
// them into each OTHER. That is the one mangling that survives decoding: every other character
// in this probe degrades to something outside the alphabet, which a decoder can reject, while
// these three degrade to valid digits and silently change the forecast. Pairing each with its
// twin makes the swap readable directly off the bubble as "$$@@__".
function gsmMarked(): string {
  let s = "";
  for (let i = 0; i < GSM_EXTRA.length; i++) s += MARKERS[i] + GSM_EXTRA[i];
  return s + "$¤@¡_§";
}

// Random characters from an arbitrary alphabet, one LCG byte each (modulo bias is irrelevant to
// a probe). Used for the payloads whose point is that they are incompressible — a real body is
// uniform over its alphabet, and round 2 found that compressibility, not length, decided where
// Apple's relay split. Any route whose budget is really bytes-after-compression will treat one
// of these differently from a ruler of the same length.
function alphabetRandom(chars: string, bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

// Position-coded ASCII — the ruler. Position i carries the units digit i % 10, except every
// tenth, which carries its decade (0-9, then A-Z, then a-z, so 620 positions are addressable).
// Reading "…89A123" off a screenshot gives the absolute index of that character, so ONE send
// locates a truncation or a split boundary exactly, with no copy-back and no arithmetic. It is
// probes 1-2's fullwidth-marker trick in characters a GSM-7 route will actually carry.
//
// Every character is in the protocol alphabet, which also makes this the most compressible
// payload in the file — deliberately, since it is read against an incompressible one.
const DECADES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function ruler(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += i % 10 === 0 ? DECADES[i / 10] : String(i % 10);
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
//
// 6-12 (added after the 2026-08-09 field run) probe the relay's frame budget. Field facts so
// far: 45 scattered base32768 chars fit one bubble, 66 split balanced (33+33) despite leaving
// Twilio as one segment, and 70 sequential single-block chars fit. Working model: ~140 bytes
// of UTF-8-ish budget per bubble, with block locality the variable that saved probe 1.
// (base32768's final char encodes the bit tail from a 7-bit repertoire that is 2-byte UTF-8,
// so a k-char payload is 3(k-1)+2 bytes unless the bit length divides 15 evenly.)
//   6: 46 chars b32768 (137 UTF-8 bytes) — fits iff the byte budget is at least 137; a split
//      here pins the budget to [135, 136], i.e. probe 4's length is already the cap.
//   7: 47 chars b32768 (exactly 140 bytes) — the knife edge: fits iff the budget is the full
//      140 with no per-frame overhead.
//   8: 70 random Cyrillic (2-byte UTF-8, exactly 140 bytes) — does a 2-byte block buy ~70
//      chars/bubble? Decides base2048 viability (~770 bits/bubble).
//   9: 70 random CJK (single block, high entropy, 210 bytes) — if this fits like probe 1 did,
//      capacity is locality/unit-governed and base16384 gives ~980 bits/bubble (2.2x base85).
//  10: 56 chars b32768 (164 bytes) — guaranteed split (28+28) under any ~140-byte model,
//      replicating whether the balanced split is deterministic; and if 6 and 7 somehow both
//      fit alongside probe 3's 66-char split, this bisects the (47, 66) char interval.
//  11: 67 random Cyrillic (134 bytes) — if 8 splits, distinguishes a 134-byte usable payload
//      (concat-header-style overhead) from something smaller.
//  12: 134 chars b32768 — deliberately TWO Twilio segments (67+67 units): does the relay
//      re-split each 201-byte segment (predicted 4 bubbles ~34+33+34+33), and do all parts
//      arrive in order? Decides whether long replies should be server-chunked instead.
//
// 13-14 (added 2026-08-16) are the SMS route's alphabet question, described at the top of this
// file. Both are pure GSM-7 basic, so both should behave exactly like today's replies do:
//  13: all 39 non-ASCII GSM-7 characters, marked, plus the $¤ @¡ _§ swap canaries (84 chars).
//      Short enough that "probe 13 " + payload is 93 characters, so the copy-back verifying it
//      is itself a single segment — this probe tests the inbound leg as well as the outbound.
//  14: 160 characters of base-124 (seed 43) — a full segment's worth. One message means the
//      chain kept GSM-7 and base-124 is real; three means something upgraded it to UCS-2 and
//      the whole idea costs more than it pays.
//
// 15-17 (added 2026-08-16) measure ZOLEO's per-message length, which is the only reason its `d:`
// code is still served as 160-character SMS. All three are sent twice, once with the paired
// phone online and once in airplane mode; the pair of results is the measurement.
//  15: 480-character ruler. The cap is unknown and the ruler is self-locating, so one send
//      brackets it exactly rather than a ladder of sends bisecting it: read the last character
//      that arrived. Whole ⇒ the route carries at least 480 (expected on the internet route);
//      cut at N ⇒ the cap is N; delivered in pieces ⇒ read each piece's boundaries off its own
//      characters. 480 is 4 concatenated SMS segments, so this also asks whether ZOLEO's
//      gateway reassembles them. (DECADES addresses 620 if a later round needs to go longer.)
//  16: 240 random base-85 characters — the length that was observed working over the internet,
//      in incompressible form. Read against 15: if the ruler survives a length this does not,
//      the budget is bytes-after-compression, which is exactly how Apple's relay behaved and
//      would mean no fixed character cap exists to encode against.
//  17: 240 units of position-coded wide text (probes 1-2's scheme). Asks whether ZOLEO is
//      Unicode-transparent at all. If it is, and the cap is anywhere near 240, base32768 is
//      worth far more here than the GSM-7 alphabet is — 15 bits a character against 6.4 — and
//      the truncation index is readable from the same fullwidth markers.
export const PROBES: Record<number, string> = {
  1: positionCoded(70),
  2: positionCoded(140),
  3: encode(lcgBytes(42, 123)),
  4: encode(lcgBytes(7, 84)),
  5: RISKY,
  6: encode(lcgBytes(11, 85)),
  7: encode(lcgBytes(13, 87)),
  8: blockRandom(lcgBytes(23, 70), 0x0400, 96),
  9: cjkRandom(lcgBytes(29, 140)),
  10: encode(lcgBytes(17, 104)),
  11: blockRandom(lcgBytes(31, 67), 0x0400, 96),
  12: encode(lcgBytes(19, 250)),
  13: gsmMarked(),
  14: alphabetRandom(ALPHABET + GSM_EXTRA, lcgBytes(43, 160)),
  15: ruler(480),
  16: alphabetRandom(ALPHABET, lcgBytes(47, 240)),
  17: positionCoded(240),
};

// The battery, sent as one reply per probe from a single inbound "probe all" — one field send
// instead of several. It holds the GSM-7 pair; rounds 1-2 are settled (see PROBES.md) and their
// probes remain individually sendable by number.
//
// The ZOLEO probes are deliberately NOT batteried. Each one's result is the shape it arrives in,
// and round 2's `probe all` showed a burst is both fragile over satellite (coverage was lost
// partway) and hard to read afterwards (the progress counter counted something nobody could
// identify). Three long messages queued behind each other is exactly the case where that
// ambiguity would eat the measurement, so 15-17 are sent one at a time.
const BATTERY = [13, 14];

const USAGE =
  "Probes: 13=GSM-7 x39, 14=160ch b124; ZOLEO 15=480 ruler, 16=240 rnd, 17=240 wide. " +
  "'probe all'=13,14. Old: 1-12 wide/b32768. Verify: 'probe N <paste>'.";

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
// number) explains the probe set; "probe N" returns the payload; "probe N <text>" verifies;
// "probe all" returns the whole capacity battery, one message per probe.
export function probeReply(body: string): string | string[] | null {
  if (/^probe\s*all$/i.test(body.trim())) return BATTERY.map((n) => PROBES[n]);
  const match = body.trim().match(/^probe\s*(\d*)\s?([\s\S]*)$/i);
  if (!match) return null;
  const n = match[1] ? Number(match[1]) : NaN;
  const expected = PROBES[n];
  if (!expected) return USAGE;
  const rest = match[2].trim();
  return rest ? verify(n, expected, rest) : expected;
}
