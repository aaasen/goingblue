import { describe, it, expect } from "vitest";
import { tokenize, detokenize } from "../scripts/avalanche/tokenizer.ts";
import { Model } from "../scripts/avalanche/model.ts";
import { encode, decode, modelBits } from "../scripts/avalanche/codec.ts";
import { buildTable, normalize, encode as ransEncode, Decoder, SCALE } from "../scripts/avalanche/rans.ts";
import { htmlToText } from "../scripts/avalanche/text.ts";

const TRAIN = [
  "Wind slabs remain reactive on north through east aspects in the alpine. Use caution near ridge crests.",
  "A persistent slab problem exists on all aspects at treeline and above. Avoid steep, unsupported terrain.",
  "Storm slabs will build with 20-30 cm of new snow. Wind slabs are likely on lee features near ridge crests.",
  "The snowpack is generally well settled below treeline. Surface hoar was buried on Feb 12 and remains a concern.",
];

function trained(): Model {
  const m = new Model();
  for (const t of TRAIN) m.observe(tokenize(t), t);
  m.finalize();
  return m;
}

describe("tokenizer", () => {
  it("round-trips arbitrary text exactly", () => {
    const cases = [
      "",
      "   ",
      "Tonight's low -9 to -21 °C... wind 40 km/h!!",
      "  leading and trailing  \n\nparagraph\tbreaks ",
      "Québec: crête d'été, façade nord-ouest",
      "Unicode ’apostrophe’ and emoji ⚠️ survive",
    ];
    for (const c of cases) expect(detokenize(tokenize(c))).toBe(c);
  });

  it("keeps apostrophes inside words and splits punctuation runs", () => {
    const t = tokenize("Tonight's slant-wise ... && 70s");
    expect(t.words).toEqual(["Tonight's", "slant", "-", "wise", "...", "&&", "70s"]);
    expect(t.seps).toHaveLength(t.words.length + 1);
  });
});

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

describe("codec", () => {
  it("round-trips seen, unseen, and non-ASCII text", () => {
    const m = trained();
    const cases = [
      TRAIN[0],
      "Wind slabs remain reactive on north through east aspects at treeline.",
      "Completely novel words like Kokanee and Zymoetz with -12 °C and a\n\nparagraph break.",
      "",
      "\n",
    ];
    for (const c of cases) expect(decode(m, encode(m, c))).toBe(c);
  });

  it("charges seen text far less than novel text", () => {
    const m = trained();
    const seen = modelBits(m, TRAIN[0]) / TRAIN[0].length;
    const novel = "xq zvk qpl mnb vcx".repeat(5);
    const unseen = modelBits(m, novel) / novel.length;
    expect(seen).toBeLessThan(2);
    expect(unseen).toBeGreaterThan(seen * 3);
  });

  it("model bits match the coded size within the coder's overhead", () => {
    const m = trained();
    const text = TRAIN.join("\n\n") + " Wind slabs are likely near ridge crests on east aspects.";
    const bytes = encode(m, text).length;
    const bits = modelBits(m, text);
    expect(bytes * 8).toBeGreaterThanOrEqual(bits);
    expect(bytes * 8).toBeLessThan(bits + 64);
  });
});

describe("htmlToText", () => {
  it("turns paragraphs into blank lines and decodes entities", () => {
    expect(htmlToText(" <p>5&nbsp;cm of snow &amp; wind.</p><p></p><p>Next <a href=\"x\">line</a>.</p>"))
      .toBe("5 cm of snow & wind.\n\nNext line.");
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("one\n\ntwo");
    expect(htmlToText(null)).toBe("");
  });
});
