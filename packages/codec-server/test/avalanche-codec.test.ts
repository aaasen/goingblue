import { describe, it, expect } from "vitest";
import { buildTable, normalize, encode as ransEncode, Decoder, SCALE } from "@weather/protocol/avalanche-codec/rans";
import { readFileSync } from "node:fs";
import { structuredOf } from "@weather/protocol/avalanche-codec/structured";
import {
  PROSE_MODEL_FILE, UNENCODED, decodeBulletin, encodeBulletin, loadStructured, packStructured, quantizeIssued, readBulletin,
  withPlaceholders, type AvalancheForecast, type Models,
} from "@weather/protocol";
import { proseCoder } from "../src/avalanche.ts";
import { htmlToText } from "../src/html-text.ts";
import { parseMarks, stripMarks } from "@weather/protocol";
import { StructuredBuilder } from "../scripts/avalanche/structured.ts";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";

describe("rans", () => {
  it("normalizes counts to exactly SCALE with no zero", () => {
    const f = normalize([1, 1, 1000000, 3]);
    expect(f.reduce((a, b) => a + b, 0)).toBe(SCALE);
    expect(Math.min(...f)).toBeGreaterThanOrEqual(1);
  });

  it("round-trips a symbol sequence across skewed tables", () => {
    const a = buildTable([[0, 1000], [1, 1], [2, 5]]);
    const b = buildTable([[7, 1], [9, 1]]);
    const seq: [typeof a, number][] = [];
    for (let i = 0; i < 2000; i++) seq.push(i % 7 === 0 ? [b, i % 2 ? 7 : 9] : [a, i % 13 === 0 ? 1 : i % 5 === 0 ? 2 : 0]);
    const blob = ransEncode(seq);
    const dec = new Decoder(blob);
    for (const [table, sym] of seq) expect(dec.get(table)).toBe(sym);
  });
});

describe("htmlToText", () => {
  it("turns paragraphs into blank lines and decodes entities", () => {
    expect(htmlToText(" <p>5&nbsp;cm of snow &amp; wind.</p><p></p><p>Next <a href=\"x\">line</a>.</p>"))
      .toBe("5 cm of snow & wind.\n\nNext line.");
    expect(htmlToText(null)).toBe("");
  });

  const [B, b, I, i, ITEM, NUM, IN] = "\uE000\uE001\uE002\uE003\uE004\uE005\uE006";
  it("marks bold and italic runs, with spaces outside the marks", () => {
    expect(htmlToText("<p>Watch for <strong> wind slabs </strong>near <em>ridgelines</em>.</p>"))
      .toBe(`Watch for ${B}wind slabs${b} near ${I}ridgelines${i}.`);
    expect(htmlToText("<b>Very <i>dangerous</i></b> today")).toBe(`${B}Very ${I}dangerous${i}${b} today`);
    expect(htmlToText('<span style="font-weight: 700">Heads up</span>: <span style="color:red">storm</span>')).toBe(`${B}Heads up${b}: storm`);
  });
  it("drops empty runs, merges adjacent ones and ends a run at each line", () => {
    expect(htmlToText("a<strong> </strong>b <strong>c</strong><strong>d</strong>")).toBe(`a b ${B}cd${b}`);
    expect(htmlToText("<strong><p>one</p><p>two<br>three</p></strong>")).toBe(`${B}one${b}\n\n${B}two${b}\n${B}three${b}`);
    expect(htmlToText("<h2>Summary</h2><p>Text</p>")).toBe(`${B}Summary${b}\n\nText`);
  });
  it("marks list items with their kind and depth", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe(`${ITEM}one\n\n${ITEM}two`);
    expect(htmlToText("<p>Do:</p><ol><li>dig<ul><li><b>deep</b></li></ul></li><li>look</li></ol>"))
      .toBe(`Do:\n\n${NUM}dig\n\n${IN}${ITEM}${B}deep${b}\n\n${NUM}look`);
    expect(htmlToText("<ul><li> </li></ul>")).toBe("");
  });
  it("removes mark characters the source already has", () => {
    expect(htmlToText("a\uE000b&#xE004;c")).toBe("abc");
  });
  it("leaves the text unchanged apart from the marks", () => {
    const html = "<p>Up to <strong>30&nbsp;cm</strong>  of <em>new</em> snow.</p><ul><li>Avoid <b>lee</b> slopes</li></ul>";
    expect(stripMarks(htmlToText(html))).toBe("Up to 30 cm of new snow.\n\nAvoid lee slopes");
  });
});

describe("parseMarks", () => {
  it("reads paragraphs, runs and numbered items", () => {
    const blocks = parseMarks(htmlToText("<p>A <b>b</b></p><ol><li>x</li><li>y<ul><li>z</li></ul></li><li>w</li></ol>"));
    expect(blocks.map((k) => [k.list, k.depth, k.number])).toEqual([["", 0, 0], ["numbered", 0, 1], ["numbered", 0, 2], ["bullet", 1, 0], ["numbered", 0, 3]]);
    expect(blocks[0].lines).toEqual([[{ text: "A ", bold: false, italic: false }, { text: "b", bold: true, italic: false }]]);
  });
});

// A forecast with every coded field set, for the bulletin tests to vary.
function forecast(over: Partial<AvalancheForecast> = {}): AvalancheForecast {
  return {
    center: "avalanche-canada", issuedBy: "Avalanche Canada", author: "", region: "Sea to Sky", pieces: [6, 27, 72],
    issued: Date.parse("2026-02-28T23:00:00Z"), expires: Date.parse("2026-03-01T23:00:00Z"),
    timezone: "America/Vancouver",
    bottomLine: "Storm slabs will build with 20-30 cm of new snow.",
    danger: [
      { date: "2026-03-01", alp: "considerable", tln: "moderate", btl: "low" },
      { date: "2026-03-02", alp: "considerable", tln: "moderate", btl: "low" },
      { date: "2026-03-03", alp: "high", tln: "considerable", btl: "moderate" },
    ],
    advice: ["Avoid freshly wind-loaded features.", "Make conservative terrain choices."],
    problems: [{
      type: "windSlab", elevations: ["tln", "alp"], aspects: ["n", "ne", "e", "nw"],
      likelihood: "likely", size: { min: 1, max: 2 },
      description: "Wind slabs remain reactive on north through east aspects in the alpine.",
    }],
    avalancheSummary: "Several size 1 wind slabs were reported.",
    snowpackSummary: "The snowpack is generally well settled below treeline.",
    hazardDiscussion: "",
    weather: [
      { label: "Saturday Night", text: "Clear skies. 20 km/h northwest ridgetop wind." },
      { label: "Sunday", text: "Sunny.\n\nTreeline temperature -5 °C." },
    ],
    confidence: { rating: "moderate", statements: ["We are uncertain how quickly slabs are gaining strength."] },
    ...over,
  };
}

const QUIET = forecast({
  danger: [{ date: "2026-03-01", alp: "low", tln: "low", btl: "low" }, { date: "2026-03-02", alp: "moderate", tln: "low", btl: "low" }],
  confidence: { rating: "high", statements: [] },
  problems: [],
});

const PROSE = proseCoder(readFileSync(new URL(`../../protocol/assets/${PROSE_MODEL_FILE}`, import.meta.url)));

describe("bulletin", () => {
  const modelsOf = (fs: AvalancheForecast[]): Models => {
    const b = new StructuredBuilder();
    for (const f of fs) b.observe(structuredOf(f));
    return { structured: b.build(), prose: PROSE };
  };
  const models = () => modelsOf([forecast(), QUIET]);
  const roundTrip = async (m: Models, f: AvalancheForecast) => decodeBulletin(m, await encodeBulletin(m, f), quantizeIssued(f.issued));

  it("round-trips a forecast, filling the fields the wire does not carry with placeholders", async () => {
    const m = models();
    for (const f of [forecast(), QUIET]) expect(await roundTrip(m, f)).toEqual(withPlaceholders(f));
    const back = await roundTrip(m, forecast());
    expect(back).toMatchObject(UNENCODED);
    expect(back.danger.map((d) => d.date)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("round-trips unseen values and dates, empty prose, and unlabeled weather periods", async () => {
    const m = models();
    const novel = forecast({
      bottomLine: "",
      danger: [{ date: "2026-03-06", alp: "extreme", tln: "spring", btl: "noRating" }],
      advice: ["", "Novel Zymoetz advice."],
      problems: [
        { type: "cornice", elevations: ["alp"], aspects: [], likelihood: "veryLikely-certain", size: { min: 3, max: 4.5 }, description: "" },
        { type: "windSlab", elevations: ["btl", "tln", "alp"], aspects: ["s"], likelihood: "unlikely-possible", size: { min: 1.5, max: 1.5 }, description: "Novel Kokanee text." },
      ],
      avalancheSummary: "",
      weather: [{ label: "", text: "Unheaded weather prose." }, { label: "Monday", text: "" }],
      confidence: { rating: "noRating", statements: ["First.", "Second statement."] },
    });
    expect(await roundTrip(m, novel)).toEqual(withPlaceholders(novel));
  });

  it("round-trips a hazard discussion and a problem's exact cells", async () => {
    const nwac = forecast({
      pieces: [101],
      advice: [], avalancheSummary: "", snowpackSummary: "", weather: [],
      hazardDiscussion: "Novel discussion of the crust.",
      author: "Irene Henninger",
      confidence: { rating: "noRating", statements: [] },
      problems: [{
        type: "wetLoose", elevations: ["tln", "alp"], aspects: ["n", "ne", "s"],
        cells: [{ aspect: "s", elevation: "tln" }, { aspect: "n", elevation: "alp" }, { aspect: "ne", elevation: "alp" }, { aspect: "s", elevation: "alp" }],
        likelihood: "possible", size: { min: 1, max: 2 }, description: "Novel wet loose text.",
      }],
    });
    expect(await roundTrip(modelsOf([forecast(), nwac]), nwac)).toEqual(withPlaceholders(nwac));
  });

  it("charges seen structure a few bits and unseen values many", () => {
    const { structured } = models();
    expect(structured.bits(structuredOf(forecast()))).toBeLessThan(28);
    const unseen = forecast({ confidence: { rating: "low", statements: [] } });
    expect(structured.bits(structuredOf(unseen))).toBeGreaterThan(30);
  });

  it("encodes identically after packing and loading", async () => {
    const m = models();
    const loaded = { ...m, structured: loadStructured(packStructured(m.structured)) };
    for (const f of [forecast(), QUIET]) {
      const bytes = await encodeBulletin(m, f);
      expect(await encodeBulletin(loaded, f)).toEqual(bytes);
      expect(await decodeBulletin(loaded, bytes, quantizeIssued(f.issued))).toEqual(withPlaceholders(f));
    }
    // A file that starts off an 8-byte boundary still loads.
    const packed = packStructured(m.structured);
    const shifted = new Uint8Array(packed.length + 1).subarray(1);
    shifted.set(packed);
    expect(await encodeBulletin({ ...m, structured: loadStructured(shifted) }, forecast())).toEqual(await encodeBulletin(m, forecast()));
  });

  it("rejects bytes the models did not write", async () => {
    const m = models();
    const f = forecast();
    const issued = quantizeIssued(f.issued);
    const bytes = await encodeBulletin(m, f);
    // A flip in the prose runs the prose model until it fails, hence the long timeout.
    for (let k = 0; k < bytes.length; k++) {
      const flipped = bytes.slice();
      flipped[k] ^= 0x10;
      await expect(decodeBulletin(m, flipped, issued), `byte ${k}`).rejects.toThrow();
    }
    const other = modelsOf([QUIET, forecast({ confidence: { rating: "low", statements: [] } })]);
    await expect(decodeBulletin(m, await encodeBulletin(other, f), issued)).rejects.toThrow();
    expect(() => readBulletin(m.structured, bytes.subarray(0, bytes.length - 3), issued)).toThrow(/incomplete/);
    expect(() => readBulletin(m.structured, new Uint8Array([0xff, 0xff]), issued)).toThrow();
  }, 120_000);

  it("round-trips the Sea to Sky forecast", async () => {
    const f = SEA_TO_SKY as AvalancheForecast;
    expect(await roundTrip(modelsOf([f]), f)).toEqual(withPlaceholders(f));
  });
});
