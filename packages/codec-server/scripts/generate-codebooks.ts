/**
 * Run every codebook derivation script (scripts/derive-*-codebooks.ts, auto-discovered) against
 * the cached corpus and write the resulting weight tables to
 * packages/protocol/src/codebooks.gen.ts:
 *
 *   pnpm generate                       # from the repo root (builds the protocol first)
 *
 * The corpus lives in the SQLite DB at data/corpus.db — expand it with
 * `pnpm exec tsx scripts/benchmark.ts --collect-only` (or import an old JSON tree: import-corpus-json.ts).
 * The tables are v4 wire format, so after regenerating: rebuild the protocol, regenerate the wire
 * fixture (packages/protocol/scripts/generate-fixture.ts), and run the protocol tests —
 * test/codebooks.test.ts fails until the protocol version is bumped (the deliberate manual step)
 * and the new codebook digest recorded.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
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
// the cached forecast corpus (data/raw/gfs). These tables are v4 wire format — regenerating
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
