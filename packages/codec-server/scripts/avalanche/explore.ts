/**
 * Where the bits go: re-walks the encoder over the held-out bulletins and attributes cost to
 * individual tokens, then aggregates by category and lists the most expensive symbols. Same
 * split and model as benchmark.ts.
 *
 * Usage: pnpm avalanche-explore [--test-frac 0.2] [--top 30]
 */
import { tokenCosts, type TokenCost } from "./codec.ts";
import { Model } from "./model.ts";
import { loadBulletins, split, arg } from "./benchmark.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;

interface Acc { n: number; bits: number; examples: Map<string, number> }
const acc = (m: Map<string, Acc>, key: string, bits: number, example?: string): void => {
  const a = m.get(key) ?? { n: 0, bits: 0, examples: new Map() };
  a.n++;
  a.bits += bits;
  if (example !== undefined) a.examples.set(example, (a.examples.get(example) ?? 0) + 1);
  m.set(key, a);
};

const isNumber = (t: string) => /^\p{N}/u.test(t);
const isAllCaps = (t: string) => t.length > 1 && t === t.toUpperCase() && t !== t.toLowerCase();
const isCapitalized = (t: string) => t[0] !== t[0].toLowerCase() && t.slice(1) === t.slice(1).toLowerCase();

function category(c: TokenCost, lowerVocab: Set<string>): string {
  const t = c.token;
  if (c.stream === "sep") {
    if (c.rung === "bytes") return "sep: OOV literal";
    if (t === " ") return "sep: space";
    if (t === "") return "sep: none";
    return /\n/.test(t) ? "sep: newline" : "sep: punctuation";
  }
  if (c.rung === "bytes") return "word: OOV literal";
  if (isNumber(t)) return "number";
  if (isAllCaps(t)) return "word: ALL CAPS";
  if (isCapitalized(t)) return lowerVocab.has(t.toLowerCase()) ? "word: Capitalized (lowercase form known)" : "word: Capitalized (proper)";
  return "word: lowercase";
}

function table(title: string, rows: [string, Acc][], totalBits: number, top: number, showMean = true): void {
  console.log(`\n${title}`);
  console.log(`  ${"token".padEnd(30)} ${"count".padStart(7)} ${"bits".padStart(10)} ${"share".padStart(6)} ${(showMean ? "bits each" : "").padStart(9)}`);
  for (const [k, a] of rows.slice(0, top)) {
    console.log(`  ${JSON.stringify(k).padEnd(30)} ${fmt(a.n).padStart(7)} ${fmt(Math.round(a.bits)).padStart(10)} ${pct(a.bits, totalBits).padStart(6)} ${(showMean ? (a.bits / a.n).toFixed(1) : "").padStart(9)}`);
  }
}

function main(): void {
  const testFrac = arg("--test-frac", 0.2);
  const top = arg("--top", 30);
  const docs = loadBulletins();
  const { train, test } = split(docs, testFrac);
  const model = new Model();
  for (const d of train) for (const s of d.sections) model.observe(s);
  model.finalize();

  // Lowercase forms known to any stream, for spotting capitalization variants.
  const lowerVocab = new Set<string>();
  for (const s of model.streams.values()) for (const t of s.vocab.tokens) if (t === t.toLowerCase()) lowerVocab.add(t);

  const byCategory = new Map<string, Acc>();
  const byToken = new Map<string, Acc>();
  const oov = new Map<string, Acc>();
  const capVariants = new Map<string, Acc>();
  let totalBits = 0;
  let chars = 0;
  let sectionsSeen = 0;
  for (const d of test) {
    for (const s of d.sections) {
      sectionsSeen++;
      chars += s.text.length;
      for (const c of tokenCosts(model, s)) {
        totalBits += c.bits;
        const cat = category(c, lowerVocab);
        acc(byCategory, cat, c.bits, c.token);
        acc(byToken, `${c.stream === "sep" ? "sep " : ""}${c.token}`, c.bits);
        if (c.rung === "bytes" && c.stream === "word") acc(oov, c.token, c.bits);
        if (cat.startsWith("word: Capitalized (lowercase") || cat === "word: ALL CAPS") acc(capVariants, c.token, c.bits);
      }
    }
  }
  console.log(`${fmt(test.length)} held-out bulletins, ${fmt(sectionsSeen)} sections, ${fmt(chars)} chars, ${fmt(Math.round(totalBits))} model bits (${(totalBits / chars).toFixed(3)} bits/char)`);

  console.log(`\nby category`);
  console.log(`  ${"category".padEnd(42)} ${"tokens".padStart(8)} ${"bits".padStart(10)} ${"share".padStart(6)} ${"bits each".padStart(9)}  examples`);
  for (const [k, a] of [...byCategory].sort((x, y) => y[1].bits - x[1].bits)) {
    const ex = [...a.examples].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([t]) => JSON.stringify(t)).join(" ");
    console.log(`  ${k.padEnd(42)} ${fmt(a.n).padStart(8)} ${fmt(Math.round(a.bits)).padStart(10)} ${pct(a.bits, totalBits).padStart(6)} ${(a.bits / a.n).toFixed(1).padStart(9)}  ${ex}`);
  }

  table("most expensive tokens by total bits", [...byToken].sort((x, y) => y[1].bits - x[1].bits), totalBits, top);
  table("most expensive tokens by bits each (seen 20+ times)", [...byToken].filter(([, a]) => a.n >= 20).sort((x, y) => y[1].bits / y[1].n - x[1].bits / x[1].n), totalBits, top);
  table("capitalization variants of known lowercase words, by total bits", [...capVariants].sort((x, y) => y[1].bits - x[1].bits), totalBits, top);
  table("OOV literals (spelled out as bytes), by total bits", [...oov].sort((x, y) => y[1].bits - x[1].bits), totalBits, top);

  const oovOnce = [...oov].filter(([, a]) => a.n === 1);
  const oovBits = [...oov.values()].reduce((a, b) => a + b.bits, 0);
  console.log(`\nOOV literals: ${fmt(oov.size)} distinct, ${fmt(oovOnce.length)} seen once, ${fmt(Math.round(oovBits))} bits (${pct(oovBits, totalBits)})`);
  console.log(`  sample of singletons: ${oovOnce.slice(0, 40).map(([t]) => t).join("  ")}`);
}

main();
