import { describe, expect, it } from "vitest";
import { decode } from "base32768";
import { ALPHABET } from "@weather/protocol";
import { GSM_EXTRA, PROBES, probeReply } from "../src/probes.js";

// GSM-7 basic set (same restriction as the protocol ALPHABET, plus space). Verdict replies must
// stay inside it so PASS/FAIL always arrives as a single unsplit message, even over satellite.
const GSM_BASIC =
  "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const isGsmBasic = (s: string) => [...s].every((c) => GSM_BASIC.includes(c));

describe("probe payloads", () => {
  it("have the frame-calibrated UTF-16 lengths", () => {
    expect(PROBES[1].length).toBe(70);
    expect(PROBES[2].length).toBe(140);
    expect(PROBES[3].length).toBe(66);
    expect(PROBES[4].length).toBe(45);
    // "probe 4 " prefix + payload must fit one 70-unit frame for the in-field round trip.
    expect("probe 4 ".length + PROBES[4].length).toBeLessThanOrEqual(70);
  });

  it("position-codes probes 1, 2 and 17 with fullwidth markers every 10 units", () => {
    // 17 runs to decade 23, so its markers reach Ｎ — still inside the fullwidth letters.
    for (const [n, len] of [[1, 70], [2, 140], [17, 240]] as const) {
      const s = PROBES[n];
      for (let i = 0; i < len; i++) {
        const expected = i % 10 === 0
          ? (i / 10 < 10 ? 0xff10 + i / 10 : 0xff21 + (i / 10 - 10))
          : 0x4e00 + i;
        expect(s.charCodeAt(i)).toBe(expected);
      }
    }
  });

  it("round-trips probes 3 and 4 through base32768", () => {
    expect(decode(PROBES[3])).toHaveLength(123);
    expect(decode(PROBES[4])).toHaveLength(84);
  });

  it("sizes the capacity battery to its frame-budget predictions", () => {
    // base32768 ladder in UTF-8 bytes: 137 (fits iff budget >= 137), 140 (knife edge),
    // 164 (guaranteed split), 401 across exactly two Twilio UCS-2 segments (67+67 units).
    const ladder = [
      [6, 46, 137],
      [7, 47, 140],
      [10, 56, 164],
      [12, 134, 401],
    ] as const;
    for (const [n, chars, bytes] of ladder) {
      expect(PROBES[n].length).toBe(chars);
      expect(Buffer.byteLength(PROBES[n], "utf8")).toBe(bytes);
      expect(() => decode(PROBES[n])).not.toThrow();
    }
    // Single-block probes: Cyrillic at exactly 140 and 134 UTF-8 bytes, CJK at 70 chars.
    expect(PROBES[8].length).toBe(70);
    expect(PROBES[11].length).toBe(67);
    expect(PROBES[9].length).toBe(70);
    expect(Buffer.byteLength(PROBES[8], "utf8")).toBe(140);
    expect(Buffer.byteLength(PROBES[11], "utf8")).toBe(134);
    expect(Buffer.byteLength(PROBES[9], "utf8")).toBe(210);
  });

  it("draws single-block probes only from their blocks, skipping combining marks", () => {
    for (const c of PROBES[8] + PROBES[11]) {
      const u = c.charCodeAt(0);
      expect(u).toBeGreaterThanOrEqual(0x0400);
      expect(u).toBeLessThan(0x0460);
    }
    for (const c of PROBES[9]) {
      const u = c.charCodeAt(0);
      expect(u).toBeGreaterThanOrEqual(0x4e00);
      expect(u).toBeLessThan(0x4e00 + 20992);
    }
  });

  it("covers the GSM-7 non-ASCII repertoire exactly once, and only it", () => {
    // The list is transcribed from the GSM 03.38 basic table, so check it against the table the
    // verdict replies are held to: every extra is GSM-7, none is ASCII, and none repeats.
    expect([...GSM_EXTRA]).toHaveLength(39);
    expect(new Set(GSM_EXTRA).size).toBe(39);
    for (const c of GSM_EXTRA) {
      expect(GSM_BASIC).toContain(c);
      expect(c.codePointAt(0)).toBeGreaterThan(0x7f);
    }
    // The extras and the protocol alphabet are what a base-124 body would be built from, and
    // they must not overlap — the alphabet is GSM-7 basic INTERSECT ASCII by construction.
    for (const c of ALPHABET) expect(GSM_EXTRA).not.toContain(c);
    expect(ALPHABET.length + GSM_EXTRA.length).toBe(124);
  });

  it("marks every extra in probe 13 and pairs the three ASCII-collision twins", () => {
    expect(PROBES[13]).toHaveLength(84); // 39 marker+char pairs, then 6 chars of canary
    const markers = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";
    for (let i = 0; i < GSM_EXTRA.length; i++) {
      expect(PROBES[13].slice(i * 2, i * 2 + 2)).toBe(markers[i] + GSM_EXTRA[i]);
    }
    // ¤/¡/§ sit at the septet positions ASCII gives $/@/_ — the swap that decodes silently.
    expect(PROBES[13].endsWith("$¤@¡_§")).toBe(true);
    // "probe 13 " + payload must fit one 160-char segment so the copy-back tests inbound too.
    expect("probe 13 ".length + PROBES[13].length).toBeLessThanOrEqual(160);
  });

  it("fills probe 14 with a full segment of base-124", () => {
    expect(PROBES[14]).toHaveLength(160);
    for (const c of PROBES[14]) expect(ALPHABET + GSM_EXTRA).toContain(c);
    // Only worth sending if it actually exercises the non-ASCII half of the alphabet.
    expect([...PROBES[14]].some((c) => GSM_EXTRA.includes(c))).toBe(true);
  });

  it("keeps the GSM-7 probes inside GSM-7 basic, so a split can only mean UCS-2", () => {
    for (const n of [13, 14]) expect(isGsmBasic(PROBES[n])).toBe(true);
  });

  it("makes probe 15's ruler read its own absolute index at every position", () => {
    // The whole point of the ruler is that a screenshot gives the truncation index with no
    // copy-back, so check the property the field reading relies on: at every tenth position the
    // decade, everywhere else the units digit.
    const decades = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    expect(PROBES[15]).toHaveLength(480);
    for (let i = 0; i < 480; i++) {
      expect(PROBES[15][i]).toBe(i % 10 === 0 ? decades[i / 10] : String(i % 10));
    }
    // 480 must stay inside the addressable range, or two positions would read alike.
    expect(480 / 10).toBeLessThanOrEqual(decades.length);
  });

  it("sizes the ZOLEO probes to the length that was seen working over the internet", () => {
    expect(PROBES[16]).toHaveLength(240);
    expect(PROBES[17]).toHaveLength(240);
    // 16 is the incompressible reading of 15's alphabet; 17 is the wide one. Different
    // repertoires, same length, so a difference in what arrives is about content, not size.
    for (const c of PROBES[16]) expect(ALPHABET).toContain(c);
    for (const c of PROBES[17]) expect(c.codePointAt(0)).toBeGreaterThan(0x7f);
  });

  it("keeps the ruler and the base-85 probe inside the protocol alphabet", () => {
    // Both must be carryable by every route under test, including a strict GSM-7 one, or a
    // failure would be ambiguous between "too long" and "wrong characters".
    for (const n of [15, 16]) {
      expect(isGsmBasic(PROBES[n])).toBe(true);
      for (const c of PROBES[n]) expect(ALPHABET).toContain(c);
    }
  });

  it("keeps probe 5's NFD sequence and NBSP distinct from their lookalikes", () => {
    expect(PROBES[5]).toContain("GéHé");
    expect(PROBES[5]).toContain("S T");
  });

  it("payloads are deterministic across calls", () => {
    expect(probeReply("probe 3")).toBe(PROBES[3]);
    expect(probeReply("probe 3")).toBe(PROBES[3]);
  });
});

describe("probeReply", () => {
  it("ignores non-probe messages", () => {
    expect(probeReply("v1 46.5,-121.4 p:d c:160")).toBeNull();
    expect(probeReply("help")).toBeNull();
  });

  it("returns usage for bare or unknown probe commands", () => {
    expect(probeReply("probe")).toContain("Probes:");
    expect(probeReply("probe 99")).toContain("Probes:");
    expect(probeReply("Probe")).toContain("Probes:");
  });

  it("returns the open round's battery as one message per probe for 'probe all'", () => {
    const battery = probeReply("probe all");
    expect(battery).toEqual([13, 14].map((n) => PROBES[n]));
    expect(probeReply("Probe All")).toEqual(battery);
  });

  it("returns payloads for 'probe N' in any casing/spacing", () => {
    expect(probeReply("probe 1")).toBe(PROBES[1]);
    expect(probeReply("Probe 1")).toBe(PROBES[1]);
    expect(probeReply("probe1")).toBe(PROBES[1]);
  });

  it("verifies an intact copy-back as PASS", () => {
    expect(probeReply(`probe 4 ${PROBES[4]}`)).toBe("PASS probe 4: all 45 chars intact");
  });

  it("reports a truncated copy-back as PARTIAL", () => {
    expect(probeReply(`probe 1 ${PROBES[1].slice(0, 30)}`)).toBe(
      "PARTIAL probe 1: first 30/70 chars intact (rest missing)",
    );
  });

  it("reports a substituted character as FAIL with its position and code points", () => {
    const mangled = PROBES[5].replace("“", '"');
    const reply = probeReply(`probe 5 ${mangled}`)!;
    expect(reply).toContain("FAIL probe 5");
    expect(reply).toContain("@1");
    expect(reply).toContain("U+201C");
  });

  it("catches the ¤/$ swap in a probe 13 copy-back", () => {
    const reply = probeReply(`probe 13 ${PROBES[13].replace(/¤/g, "$")}`)!;
    expect(reply).toContain("FAIL probe 13");
    expect(reply).toContain("sent U+A4 got U+24");
  });

  it("reports a length mismatch when the copy-back has trailing extras", () => {
    expect(probeReply(`probe 4 ${PROBES[4]}x`)).toContain("length 46 vs 45");
  });

  it("keeps all verdict and usage replies inside GSM-7 basic", () => {
    const replies = [
      probeReply("probe")!,
      probeReply(`probe 4 ${PROBES[4]}`)!,
      probeReply(`probe 1 ${PROBES[1].slice(0, 10)}`)!,
      probeReply(`probe 5 ${PROBES[5].replace("—", "-")}`)!,
      probeReply(`probe 13 ${PROBES[13]}`)!,
      probeReply(`probe 14 ${PROBES[14].replace("£", "?")}`)!,
    ];
    for (const r of replies) {
      expect(isGsmBasic(r)).toBe(true);
      expect(r.length).toBeLessThanOrEqual(160);
    }
  });
});
