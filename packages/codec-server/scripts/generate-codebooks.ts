/**
 * Run the codebook derivation scripts (scripts/derive-*-codebooks.ts, auto-discovered) against
 * the cached corpus and write each script's weight tables to its own generated file under
 * packages/protocol/src/codebooks (see renderCodebookFile in derive-lib.ts):
 *
 *   pnpm generate                       # every script, from the repo root (builds the protocol first)
 *   pnpm generate --only wind-dir       # one script: derive-wind-dir-codebooks.ts (repeatable)
 *
 * A file is rewritten only when its tables changed, so its header date records when the weights
 * last moved and a no-op run leaves the tree clean. codebooks/index.gen.ts re-exports every file
 * present and is refreshed on every run.
 *
 * The corpus lives in the SQLite DB at data/corpus.db — expand it with
 * `pnpm exec tsx scripts/benchmark.ts --collect-only` (or import an old JSON tree: import-corpus-json.ts).
 * The tables are wire format, so after regenerating: rebuild the protocol, regenerate the wire
 * fixture (packages/protocol/scripts/generate-fixture.ts), and run the protocol tests —
 * test/codebooks.test.ts fails until the new codebook digest is recorded (the deliberate manual step).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CODEBOOKS_DIR, codebookFileFor, codebookFileUnchanged, codebookNameOf, deriveCountsMulti,
  renderCodebookFile, type CellCounter, type DerivedTables,
} from "./derive-lib.ts";
import { DB_PATH } from "./corpus-db.ts";

const dir = dirname(fileURLToPath(import.meta.url));

if (!existsSync(DB_PATH)) {
  console.error(`No corpus DB at ${DB_PATH} — run \`pnpm exec tsx scripts/benchmark.ts --collect-only\` first.`);
  process.exit(1);
}

const allScripts = readdirSync(dir).filter((f) => f.startsWith("derive-") && f.endsWith("-codebooks.ts")).sort();

// --only <name> selects scripts by codebook name; the rest keep their files as they are.
const only: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== "--only") { console.error(`Unknown argument: ${process.argv[i]}`); process.exit(1); }
  const name = process.argv[++i];
  if (!allScripts.some((s) => codebookNameOf(s) === name)) {
    console.error(`--only ${name}: no derive script for it (have: ${allScripts.map(codebookNameOf).join(", ")})`);
    process.exit(1);
  }
  only.push(name);
}
const scripts = only.length ? allScripts.filter((s) => only.includes(codebookNameOf(s))) : allScripts;

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

// The scan is split across processes: counting is CPU-bound and embarrassingly parallel, since
// every cell contributes independently to a flat vector of integer counts. Each shard sums its
// own vectors and the parent adds them — integers add associatively, so the result is
// bit-identical to a single-process run and cannot depend on how the shards interleave.
//
// Child processes rather than worker threads because the scripts are TypeScript: the children have
// to come up under the same tsx loader, and worker_threads does not let us pass loader flags
// through per worker. tsx's CLI is resolved from the package rather than taken from
// process.argv[1] — tsx re-execs, so by the time this file is running argv[1] is this script, and
// spawning that under bare node gets far enough to strip the types and then fails to resolve the
// codebase's `.js` specifiers back to `.ts`. SQLite is read-only here and the DB is in WAL mode,
// so concurrent readers are safe.
const TSX_CLI = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
const WORKERS = existsSync(TSX_CLI)
  ? Number(process.env.DERIVE_WORKERS ?? "") || Math.max(1, cpus().length - 2)
  : 1; // no loader to hand the children — fall back to scanning in this process
const nSlots = mods.map((m) => m.counter.nSlots);

async function scanSharded(): Promise<Float64Array[]> {
  const totals = nSlots.map((n) => new Float64Array(n));
  const tmp = mkdtempSync(join(tmpdir(), "derive-"));
  try {
    // allSettled, not all: the shards write into `tmp` as they finish, so tearing it down the
    // moment one of them fails would pull the directory out from under every sibling still
    // scanning. They then die on ENOENT while writing, and the cascade buries whichever failure
    // actually started it — which is exactly how a worker killed under memory pressure read as
    // six unexplained file-not-found errors.
    const settled = await Promise.allSettled(
      Array.from({ length: WORKERS }, (_, i) => new Promise<void>((ok, fail) => {
        const out = join(tmp, `shard-${i}.bin`);
        const child = spawn(
          process.execPath,
          [TSX_CLI, join(dir, "derive-worker.ts"), String(i), String(WORKERS), out, ...scripts],
          { stdio: ["ignore", "inherit", "inherit"] },
        );
        child.on("error", fail);
        child.on("exit", (code, signal) => {
          // A signal rather than an exit code is the tell for the OS killing it — usually memory,
          // and usually because something else heavy is running alongside.
          if (signal) return fail(new Error(`shard ${i} killed by ${signal}`));
          if (code !== 0) return fail(new Error(`shard ${i} exited ${code}`));
          // Each shard's file is its counters' Float64Arrays back to back, in `scripts` order.
          const buf = readFileSync(out);
          let off = 0;
          for (let c = 0; c < totals.length; c++) {
            const v = new Float64Array(buf.buffer, buf.byteOffset + off, nSlots[c]);
            for (let k = 0; k < v.length; k++) totals[c][k] += v[k];
            off += nSlots[c] * 8;
          }
          ok();
        });
      })),
    );
    const failed = settled.filter((r) => r.status === "rejected");
    if (failed.length)
      throw new Error(
        `${failed.length} of ${WORKERS} shards failed; the corpus was not fully counted.\n` +
        failed.map((r) => `  ${(r as PromiseRejectedResult).reason}`).join("\n"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return totals;
}

console.log(`Scanning the corpus once for ${mods.length} derive scripts across ${WORKERS} processes…`);
const scanStarted = Date.now();
const countVecs = WORKERS > 1 ? await scanSharded() : await deriveCountsMulti(mods.map((m) => m.counter));
console.log(`(scan ${((Date.now() - scanStarted) / 1000).toFixed(1)}s)`);

mkdirSync(CODEBOOKS_DIR, { recursive: true });
const date = new Date().toISOString().slice(0, 10);
const seen = new Map<string, string>(); // table name → script that produced it
let written = 0;
for (let i = 0; i < mods.length; i++) {
  const { script, derive } = mods[i];
  console.log(`\n── ${script} ${"─".repeat(Math.max(2, 76 - script.length))}`);
  const tables = await derive(countVecs[i]);
  for (const name of Object.keys(tables)) {
    if (seen.has(name)) {
      console.error(`${script} rederived ${name}, already produced by ${seen.get(name)} — stopping.`);
      process.exit(1);
    }
    seen.set(name, script);
  }
  const path = codebookFileFor(codebookNameOf(script));
  const rendered = renderCodebookFile(script, tables, date);
  if (codebookFileUnchanged(path, rendered)) { console.log(`  unchanged: ${path}`); continue; }
  writeFileSync(path, rendered);
  written++;
  console.log(`  wrote ${path}`);
}

// The index re-exports every codebook file on disk, selected or not, so a script's tables reach
// the protocol the moment its file exists. Rewritten only when the file set changes.
const files = readdirSync(CODEBOOKS_DIR).filter((f) => f.endsWith(".gen.ts") && f !== "index.gen.ts").sort();
const index = `// GENERATED FILE, do not edit by hand. Written by \`pnpm generate\`: one line per codebook
// file in this directory, so entropy.ts imports every table from one place.

${files.map((f) => `export * from "./${f.replace(/\.ts$/, ".js")}";`).join("\n")}
`;
const indexPath = join(CODEBOOKS_DIR, "index.gen.ts");
if (!existsSync(indexPath) || readFileSync(indexPath, "utf8") !== index) writeFileSync(indexPath, index);

console.log(`\n${written} of ${mods.length} codebook files changed (${CODEBOOKS_DIR}).
To ship: rebuild the protocol, regenerate the fixture (node packages/protocol/scripts/generate-fixture.ts),
and run the protocol tests — the codebook digest test pins the tables.`);
