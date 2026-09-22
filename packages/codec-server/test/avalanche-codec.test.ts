import { describe, it, expect } from "vitest";
import { tokenize, detokenize } from "../scripts/avalanche/tokenizer.ts";
import { Model } from "../scripts/avalanche/model.ts";
import { encode, decode, sectionBits, tokenCosts } from "../scripts/avalanche/codec.ts";
import { buildTable, normalize, encode as ransEncode, Decoder, SCALE } from "../scripts/avalanche/rans.ts";
import { htmlToText, type Section } from "../scripts/avalanche/text.ts";

const TRAIN: Section[] = [
  { kind: "problem", text: "Wind slabs remain reactive on north through east aspects in the alpine. Use caution near ridge crests." },
  { kind: "problem", text: "A persistent slab problem exists on all aspects at treeline and above. Avoid steep, unsupported terrain." },
  { kind: "highlights", text: "Storm slabs will build with 20-30 cm of new snow. Wind slabs are likely on lee features near ridge crests." },
  { kind: "snowpack-summary", text: "The snowpack is generally well settled below treeline. Surface hoar was buried on Feb 12 and remains a concern." },
];

function trained(): Model {
  const m = new Model();
  for (const s of TRAIN) m.observe(s);
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

  it("keeps apostrophes inside words and puts punctuation in the separators", () => {
    const text = "Tonight's slant-wise, and more.\n\nNext (one).";
    const t = tokenize(text);
    expect(t.words).toEqual(["Tonight's", "slant", "wise", "and", "more", "Next", "one"]);
    expect(t.seps).toEqual(["", " ", "-", ", ", " ", ".\n\n", " (", ")."]);
    expect(detokenize(t)).toBe(text);
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
  it("round-trips seen, unseen, and non-ASCII sections", () => {
    const m = trained();
    const docs: Section[][] = [
      [TRAIN[0]],
      TRAIN,
      [
        { kind: "problem", text: "Wind slabs remain reactive on north through east aspects at treeline." },
        { kind: "highlights", text: "Completely novel words like Kokanee and Zymoetz with -12 °C and a\n\nparagraph break." },
        { kind: "snowpack-summary", text: "" },
        { kind: "problem", text: "\n" },
        { kind: "problem", text: "...leading, trailing punctuation!! (and) \"quotes\" ..." },
        { kind: "problem", text: "Mixed McKenzie PWLs NW 5cm A. c. iPhone ALL CAPS Here" },
      ],
      [],
    ];
    for (const d of docs) expect(decode(m, encode(m, d))).toEqual(d);
  });

  it("rejects a section kind it was not trained on", () => {
    const m = trained();
    expect(() => encode(m, [{ kind: "weather-summary", text: "Sunny." }])).toThrow(/kind/);
  });

  it("charges seen text far less than novel text", () => {
    const m = trained();
    const seen = sectionBits(m, TRAIN[0]) / TRAIN[0].text.length;
    const novel = { kind: "problem", text: "xq zvk qpl mnb vcx".repeat(5) };
    const unseen = sectionBits(m, novel) / novel.text.length;
    expect(seen).toBeLessThan(2);
    expect(unseen).toBeGreaterThan(seen * 3);
  });

  it("isolates vocabularies by kind", () => {
    const m = trained();
    // "snowpack" appears only in the snowpack summary, so as a problem it escapes to bytes.
    const asProblem = sectionBits(m, { kind: "problem", text: "snowpack" });
    const asSummary = sectionBits(m, { kind: "snowpack-summary", text: "snowpack" });
    expect(asProblem).toBeGreaterThan(asSummary * 2);
    expect(m.streamFor("problem")).not.toBe(m.streamFor("snowpack-summary"));
  });

  it("model bits match the coded size within the coder's overhead", () => {
    const m = trained();
    const doc = [...TRAIN, { kind: "problem", text: "Wind slabs are likely near ridge crests on east aspects." }];
    const bytes = encode(m, doc).length;
    let bits = 0;
    for (const s of doc) bits += sectionBits(m, s);
    expect(bytes * 8).toBeGreaterThanOrEqual(bits);
    expect(bytes * 8).toBeLessThan(bits + 64 + 8 * (doc.length + 1));
  });
});

describe("order 2", () => {
  it("uses the pair context for seen trigrams and falls back on unseen pairs", () => {
    const m = trained();
    const seen = { kind: "problem", text: "Wind slabs remain reactive on north through east aspects" };
    const rungs = tokenCosts(m, seen).filter((r) => r.stream === "word").map((r) => r.rung);
    expect(rungs.slice(2)).toEqual(rungs.slice(2).map(() => "order2"));
    // Separators between two seen words use the pair of words around them; the trailing one
    // pairs the last word with END, which this text never trained.
    const seps = tokenCosts(m, seen).filter((r) => r.stream === "sep").map((r) => r.rung);
    expect(seps.slice(0, -1)).toEqual(seps.slice(0, -1).map(() => "order2"));
    expect(seps[seps.length - 1]).not.toBe("order2");
    const novel = { kind: "problem", text: "Zymoetz Kokanee remain" };
    expect(decode(m, encode(m, [novel]))).toEqual([novel]);
    expect(tokenCosts(m, novel).filter((r) => r.stream === "word").map((r) => r.rung)).toEqual(["bytes", "bytes", "unigram"]);
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
