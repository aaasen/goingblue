/**
 * Train the Markov model on the bulletin archive and measure it on bulletins it never saw.
 *
 * The holdout is a random sample of bulletins from the whole archive. Membership is decided by
 * a hash of the product id, so a bulletin's side of the split never changes as the archive
 * grows and two runs on different snapshots compare the same documents.
 *
 * Usage: pnpm avalanche-benchmark [--test-frac 0.2] [--min-count 1] [--word-order 2|3]
 */
import { encode, decode, sectionBits } from "./codec.ts";
import { openDb } from "./db.ts";
import { Model, WORD_ORDER } from "./model.ts";
import { bulletinProse, isForecast, type BulletinProse } from "./text.ts";
import { tokenize } from "./tokenizer.ts";

// Compressed bytes that fit one satellite message on the tightest multi-message route.
const MESSAGE_BYTES = 140;

export function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

export function loadBulletins(): BulletinProse[] {
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

// FNV-1a over the id, mapped to [0, 1).
function unitHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function split(docs: BulletinProse[], testFrac: number): { train: BulletinProse[]; test: BulletinProse[] } {
  return {
    train: docs.filter((d) => unitHash(d.id) >= testFrac),
    test: docs.filter((d) => unitHash(d.id) < testFrac),
  };
}

const utf8 = new TextEncoder();
const fmt = (n: number) => n.toLocaleString("en-US");

interface SectionAcc { n: number; chars: number; bits: number }

function main(): void {
  const testFrac = arg("--test-frac", 0.2);
  const minCount = arg("--min-count", 1);

  const docs = loadBulletins();
  if (docs.length === 0) throw new Error("no forecasts in data/avalanche.db; run pnpm avalanche-collect");
  const { train, test } = split(docs, testFrac);
  console.log(`${fmt(docs.length)} bulletins with a danger rating, ${docs[0].dateIssued.slice(0, 10)} .. ${docs[docs.length - 1].dateIssued.slice(0, 10)}`);
  console.log(`  train ${fmt(train.length)} / test ${fmt(test.length)}, sampled by id hash`);

  const t0 = Date.now();
  const wordOrder = arg("--word-order", WORD_ORDER);
  console.log(`  word order ${wordOrder}`);
  const model = new Model(wordOrder);
  for (const d of train) for (const s of d.sections) model.observe(s);
  model.finalize(minCount);
  const st = model.stats();
  console.log(`\ntrained in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${st.streams} word streams, vocab ${fmt(st.wordVocab)}, ` + st.entries.map((n, k) => `order ${k + 1}: ${fmt(n)} entries over ${fmt(st.contexts[k])} contexts`).join(", "));

  const t1 = Date.now();
  let raw = 0;
  let comp = 0;
  let failures = 0;
  let oov = 0;
  let tokens = 0;
  const msgHist = new Map<number, number>();
  const bySection = new Map<string, SectionAcc>();
  for (const d of test) {
    const blob = encode(model, d.sections);
    if (JSON.stringify(decode(model, blob)) !== JSON.stringify(d.sections)) {
      failures++;
      console.log(`  ROUND TRIP FAILED: ${d.id}`);
    }
    raw += utf8.encode(d.text).length;
    comp += blob.length;
    for (const s of d.sections) {
      const stream = model.streamFor(s.kind);
      const toks = tokenize(s.text);
      tokens += toks.words.length;
      for (const w of toks.words) if (!stream.vocab.ids.has(w)) oov++;
      const acc = bySection.get(s.kind) ?? { n: 0, chars: 0, bits: 0 };
      acc.n++;
      acc.chars += s.text.length;
      acc.bits += sectionBits(model, s);
      bySection.set(s.kind, acc);
    }
    const msgs = Math.ceil(blob.length / MESSAGE_BYTES);
    msgHist.set(msgs, (msgHist.get(msgs) ?? 0) + 1);
  }
  const elapsed = (Date.now() - t1) / 1000;

  console.log(`\nwhole bulletins (${fmt(test.length)} held out)`);
  console.log(`  round trip   ${fmt(test.length - failures)}/${fmt(test.length)} exact`);
  console.log(`  size         ${fmt(raw)} -> ${fmt(comp)} bytes   ${(raw / comp).toFixed(2)}x   ${((comp * 8) / raw).toFixed(3)} bits/char`);
  console.log(`  per doc      ${(raw / test.length).toFixed(0)} chars -> ${(comp / test.length).toFixed(0)} bytes mean`);
  console.log(`  held-out OOV ${((oov / tokens) * 100).toFixed(2)}% of ${fmt(tokens)} word tokens`);
  console.log(`  throughput   ${(raw / elapsed / 1000).toFixed(0)} KB/s round trip`);
  const hist = [...msgHist].sort((a, b) => a[0] - b[0]);
  console.log(`  messages of ${MESSAGE_BYTES} bytes: ${hist.map(([m, n]) => `${m}: ${((n / test.length) * 100).toFixed(0)}%`).join("  ")}`);

  // Where the bytes of a bulletin go. Bytes are model bits / 8, so they exclude coder framing;
  // per bulletin = occurrences x bytes, since problems and advice repeat.
  const totalBits = [...bySection.values()].reduce((a, b) => a + b.bits, 0);
  const rows = [...bySection].sort((x, y) => y[1].bits - x[1].bits);
  console.log(`\nby section`);
  console.log(`  ${"section".padEnd(18)} ${"per doc".padStart(8)} ${"chars".padStart(6)} ${"bits/char".padStart(10)} ${"B/occur".padStart(8)} ${"B/doc".padStart(6)} ${"share".padStart(6)}`);
  for (const [kind, a] of rows) {
    console.log(
      `  ${kind.padEnd(18)} ${(a.n / test.length).toFixed(2).padStart(8)} ${(a.chars / a.n).toFixed(0).padStart(6)} ${(a.bits / a.chars).toFixed(3).padStart(10)}` +
      ` ${(a.bits / 8 / a.n).toFixed(1).padStart(8)} ${(a.bits / 8 / test.length).toFixed(1).padStart(6)} ${((a.bits / totalBits) * 100).toFixed(0).padStart(5)}%`,
    );
  }
  console.log(`  ${"total".padEnd(18)} ${"".padStart(8)} ${"".padStart(6)} ${(totalBits / raw).toFixed(3).padStart(10)} ${"".padStart(8)} ${(totalBits / 8 / test.length).toFixed(1).padStart(6)}`);
}

if (process.argv[1] && /benchmark\.ts$/.test(process.argv[1])) main();
