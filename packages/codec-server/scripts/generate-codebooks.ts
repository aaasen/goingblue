/**
 * Run every codebook derivation script (scripts/derive-*-codebooks.ts, auto-discovered) against
 * the cached corpus and write the resulting weight tables to
 * packages/protocol/src/codebooks.gen.ts:
 *
 *   pnpm generate                       # from the repo root (builds the protocol first)
 *
 * The corpus lives in the SQLite DB at data/corpus.db — expand it with
 * `pnpm exec tsx scripts/benchmark.ts --collect-only` (or import an old JSON tree: import-corpus-json.ts).
 * The tables are v2 wire format, so after regenerating: rebuild the protocol, regenerate the wire
 * fixture (packages/protocol/scripts/generate-fixture.ts), and run the protocol tests —
 * test/codebooks.test.ts fails until the protocol version is bumped (the deliberate manual step)
 * and the new codebook digest recorded.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveCountsMulti, renderTable, type CellCounter, type DerivedTables } from "./derive-lib.ts";
import { DB_PATH } from "./corpus-db.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(dir, "..", "..", "protocol", "src", "codebooks.gen.ts");

if (!existsSync(DB_PATH)) {
  console.error(`No corpus DB at ${DB_PATH} — run \`pnpm exec tsx scripts/benchmark.ts --collect-only\` first.`);
  process.exit(1);
}

const scripts = readdirSync(dir).filter((f) => f.startsWith("derive-") && f.endsWith("-codebooks.ts")).sort();

// Every script counts from the same cells, so the corpus is scanned ONCE for all of them:
// each script's CellCounter accumulates into its own vector during the shared pass, then
// derive(precounted) assembles tables and stats without touching the DB. (Scanned per script,
// the 27 GB corpus dominated generation time eightfold.)
interface Script { script: string; derive: (counts: Float64Array) => Promise<DerivedTables>; counter: CellCounter }
const mods: Script[] = [];
for (const script of scripts) {
  const mod = await import(pathToFileURL(join(dir, script)).href);
  if (typeof mod.derive !== "function" || typeof mod.counter !== "function") {
    console.error(`${script} exports no derive()/counter() — stopping.`);
    process.exit(1);
  }
  mods.push({ script, derive: mod.derive, counter: mod.counter() });
}

console.log(`Scanning the corpus once for ${mods.length} derive scripts…`);
const scanStarted = Date.now();
const countVecs = await deriveCountsMulti(mods.map((m) => m.counter));
console.log(`(scan ${((Date.now() - scanStarted) / 1000).toFixed(1)}s)`);

const tables: DerivedTables = {};
for (let i = 0; i < mods.length; i++) {
  const { script, derive } = mods[i];
  console.log(`\n── ${script} ${"─".repeat(Math.max(2, 76 - script.length))}`);
  for (const [name, t] of Object.entries(await derive(countVecs[i]))) {
    if (tables[name]) {
      console.error(`${script} rederived ${name}, already produced by an earlier script — stopping.`);
      process.exit(1);
    }
    tables[name] = t as number[] | number[][];
  }
}

const header = `// GENERATED FILE — do not edit by hand. Written by \`pnpm generate\`
// (packages/codec-server/scripts/generate-codebooks.ts): integer weight tables derived from
// the cached forecast corpus (data/raw/gfs). These tables are v2 wire format — regenerating
// changes what already-encoded messages mean, so test/codebooks.test.ts pins their digest per
// protocol version and fails until the version is bumped and the new digest recorded. See
// packages/protocol/src/entropy.ts for how each table is used and the derive-*-codebooks.ts
// scripts for methodology.
`;
const body = Object.entries(tables).map(([name, t]) => renderTable(name, t)).join("\n\n");
writeFileSync(OUT, `${header}\n${body}\n`);

console.log(`\nWrote ${Object.keys(tables).length} tables from ${scripts.length} scripts to ${OUT}
To ship: rebuild the protocol, regenerate the fixture (node packages/protocol/scripts/generate-fixture.ts),
and run the protocol tests — the codebook digest test enforces the manual version bump.`);
