/**
 * Run every codebook derivation script (scripts/derive-*.ts, auto-discovered) against the cached
 * corpus, in sequence:
 *
 *   pnpm generate                       # from the repo root (builds the protocol first)
 *
 * The corpus lives in data/raw/gfs — expand it with `node scripts/benchmark.ts --collect-only`.
 * Each derive script prints the weight tables to paste into packages/protocol/src/huffman.ts.
 * After pasting, regenerate the wire fixture (packages/protocol/scripts/generate-fixture.ts) and
 * run the protocol tests: test/codebooks.test.ts fails until the protocol version is bumped and
 * the new codebook digest recorded — changed tables change what already-encoded messages mean.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

const corpus = join(dir, "..", "..", "..", "data", "raw", "gfs");
if (!existsSync(corpus)) {
  console.error(`No cached corpus at ${corpus} — run \`node scripts/benchmark.ts --collect-only\` first.`);
  process.exit(1);
}

const scripts = readdirSync(dir).filter((f) => f.startsWith("derive-") && f.endsWith(".ts")).sort();

for (const script of scripts) {
  console.log(`\n── ${script} ${"─".repeat(Math.max(2, 76 - script.length))}`);
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(dir, script)], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\n${script} failed (exit ${res.status ?? "signal"}) — stopping.`);
    process.exit(res.status ?? 1);
  }
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

console.log(`\nAll ${scripts.length} derivations done. To ship changed tables: paste the printed
weights into packages/protocol/src/huffman.ts, bump the protocol version, regenerate the fixture
(node packages/protocol/scripts/generate-fixture.ts after a build), and run the protocol tests —
the codebook digest test walks you through recording the new digest.`);
