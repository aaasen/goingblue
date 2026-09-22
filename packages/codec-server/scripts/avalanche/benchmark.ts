/**
 * Train the Markov model on the bulletin archive and measure it on bulletins it never saw.
 *
 * The holdout is the most recent share of bulletins by issue time. That is the deployment
 * case: a model trained on history compresses bulletins written after it. A positional split
 * would leave yesterday's bulletin for the same region in the training set, and consecutive
 * bulletins reuse whole paragraphs, so it would flatter the ratio.
 *
 * Usage: pnpm avalanche-benchmark [--test-frac 0.2] [--min-count 1] [--section]
 */
import { encode, decode, modelBits } from "./codec.ts";
import { openDb } from "./db.ts";
import { Model } from "./model.ts";
import { bulletinProse, isForecast, type BulletinProse } from "./text.ts";
import { tokenize } from "./tokenizer.ts";

// Compressed bytes that fit one satellite message on the tightest multi-message route.
const MESSAGE_BYTES = 140;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

function loadBulletins(): BulletinProse[] {
  const db = openDb();
  const rows = db.prepare("SELECT json FROM products ORDER BY date_issued, id").all() as { json: string }[];
  db.close();
  const out: BulletinProse[] = [];
  for (const { json } of rows) {
    const p = JSON.parse(json);
    if (!isForecast(p)) continue;
    const b = bulletinProse(p);
    if (b.text) out.push(b);
  }
  return out;
}

function split(docs: BulletinProse[], testFrac: number): { train: BulletinProse[]; test: BulletinProse[]; cutoff: string } {
  const target = Math.round(docs.length * testFrac);
  const byTime = [...docs].sort((a, b) => (a.dateIssued < b.dateIssued ? 1 : -1));
  const cutoff = byTime[Math.max(0, Math.min(target, byTime.length) - 1)].dateIssued;
  return {
    train: docs.filter((d) => d.dateIssued < cutoff),
    test: docs.filter((d) => d.dateIssued >= cutoff),
    cutoff,
  };
}

const utf8 = new TextEncoder();
const fmt = (n: number) => n.toLocaleString("en-US");

function main(): void {
  const testFrac = arg("--test-frac", 0.2);
  const minCount = arg("--min-count", 1);

  const docs = loadBulletins();
  if (docs.length === 0) throw new Error("no forecasts in data/avalanche.db; run pnpm avalanche-collect");
  const { train, test, cutoff } = split(docs, testFrac);
  console.log(`${fmt(docs.length)} bulletins with a danger rating; train ${fmt(train.length)} / test ${fmt(test.length)}`);
  console.log(`  train ${train[0].dateIssued.slice(0, 10)} .. ${cutoff.slice(0, 10)}`);
  console.log(`  test  ${cutoff.slice(0, 10)} .. ${test[test.length - 1].dateIssued.slice(0, 10)}`);

  const t0 = Date.now();
  const model = new Model();
  let trainChars = 0;
  for (const d of train) {
    trainChars += d.text.length;
    model.observe(tokenize(d.text), d.text);
  }
  model.finalize(minCount);
  const st = model.stats();
  console.log(`\ntrained in ${((Date.now() - t0) / 1000).toFixed(1)} s on ${fmt(trainChars)} chars`);
  console.log(`  word vocab ${fmt(st.wordVocab)}, sep vocab ${fmt(st.sepVocab)}, ${fmt(st.wordBigrams)} bigrams over ${fmt(st.wordContexts)} contexts`);

  // Whole bulletins.
  const t1 = Date.now();
  let raw = 0;
  let comp = 0;
  let failures = 0;
  let tokens = 0;
  let oov = 0;
  const msgHist = new Map<number, number>();
  for (const d of test) {
    const blob = encode(model, d.text);
    if (decode(model, blob) !== d.text) {
      failures++;
      console.log(`  ROUND TRIP FAILED: ${d.id}`);
    }
    raw += utf8.encode(d.text).length;
    comp += blob.length;
    const toks = tokenize(d.text);
    tokens += toks.words.length;
    for (const w of toks.words) if (!model.words.ids.has(w)) oov++;
    const msgs = Math.ceil(blob.length / MESSAGE_BYTES);
    msgHist.set(msgs, (msgHist.get(msgs) ?? 0) + 1);
  }
  const elapsed = (Date.now() - t1) / 1000;
  console.log(`\nwhole bulletins (${fmt(test.length)} held out)`);
  console.log(`  round trip  ${fmt(test.length - failures)}/${fmt(test.length)} exact`);
  console.log(`  size        ${fmt(raw)} -> ${fmt(comp)} bytes   ${(raw / comp).toFixed(2)}x   ${((comp * 8) / raw).toFixed(3)} bits/char`);
  console.log(`  per doc     ${(raw / test.length).toFixed(0)} chars -> ${(comp / test.length).toFixed(0)} bytes mean`);
  console.log(`  held-out OOV ${((oov / tokens) * 100).toFixed(2)}% of ${fmt(tokens)} word tokens`);
  console.log(`  throughput  ${(raw / elapsed / 1000).toFixed(0)} KB/s round trip`);
  const hist = [...msgHist].sort((a, b) => a[0] - b[0]);
  console.log(`  messages of ${MESSAGE_BYTES} bytes: ${hist.map(([m, n]) => `${m}: ${((n / test.length) * 100).toFixed(0)}%`).join("  ")}`);

  // Each section on its own, which is what a per-section request would cost.
  const bySection = new Map<string, { n: number; chars: number; bits: number }>();
  for (const d of test) {
    for (const s of d.sections) {
      const acc = bySection.get(s.kind) ?? { n: 0, chars: 0, bits: 0 };
      acc.n++;
      acc.chars += s.text.length;
      acc.bits += modelBits(model, s.text);
      bySection.set(s.kind, acc);
    }
  }
  console.log(`\nby section (model bits, coded alone)`);
  console.log(`  ${"section".padEnd(18)} ${"n".padStart(6)} ${"chars".padStart(7)} ${"bytes".padStart(7)} ${"bits/char".padStart(10)}`);
  for (const [kind, a] of [...bySection].sort((x, y) => y[1].chars - x[1].chars)) {
    console.log(`  ${kind.padEnd(18)} ${fmt(a.n).padStart(6)} ${(a.chars / a.n).toFixed(0).padStart(7)} ${(a.bits / 8 / a.n).toFixed(0).padStart(7)} ${(a.bits / a.chars).toFixed(3).padStart(10)}`);
  }
}

main();
