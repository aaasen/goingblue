/**
 * Extract per-cell (location × window) sparse symbol counts for every derive script's counted
 * tables, over ALL best_match cells (train AND eval splits), in one corpus scan:
 *
 *   pnpm exec tsx packages/codec-server/scripts/extract-cell-counts.ts
 *
 * This is the precomputation behind codebook-class clustering (see derive-class-ladder.ts): with
 * one sparse count vector per cell, the model cost of any cell under any candidate table set is
 * a dot product (Σ counts · costBits), and a table set for any subset of cells is a sparse sum —
 * so Lloyd's/EM in code-length space, and held-out evaluation of K table sets, all run without
 * touching the corpus DB again. Slot semantics (and the exact fallback/quantization behavior of
 * the tables each slot range feeds) live in the derive scripts' counter() exports; this file
 * only concatenates their slot spaces and serializes.
 *
 * Output (paths below):
 *   data/cell-counts.meta.json  — slot layout (per script base + counted table dims) and the
 *                                 cell index: {id, ws, split, nnz} in file order.
 *   data/cell-counts.bin        — per cell, in index order: nnz × uint32 LE slot ids (ascending),
 *                                 then nnz × uint16 LE counts (clamped at 65535).
 */
import { openSync, writeSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./corpus-db.ts";
import { eachForecast, makeCellCtx, tableOffsets, type CellCounter } from "./derive-lib.ts";

export const CELL_COUNTS_BIN = join(REPO_ROOT, "data", "cell-counts.bin");
export const CELL_COUNTS_META = join(REPO_ROOT, "data", "cell-counts.meta.json");

// The derive scripts contributing counted tables, in slot-space order (alphabetical, matching
// generate-codebooks.ts discovery order).
export const COUNTER_SCRIPTS = [
  "derive-cloud-delta-codebooks",
  "derive-freeze-delta-codebooks",
  "derive-gust-delta-codebooks",
  "derive-precip-accum-codebooks",
  "derive-temp-delta-codebooks",
  "derive-weathercode-codebooks",
  "derive-wind-dir-codebooks",
  "derive-wind-speed-delta-codebooks",
] as const;

export interface ScriptSegment {
  script: string;
  base: number; // slot offset of this script's counter in the combined space
  counter: CellCounter;
}

export interface CellMeta { id: string; ws: string; split: string; nnz: number }

export async function loadSegments(): Promise<{ segments: ScriptSegment[]; nSlots: number }> {
  const segments: ScriptSegment[] = [];
  let base = 0;
  for (const script of COUNTER_SCRIPTS) {
    const mod = await import(`./${script}.ts`);
    const counter: CellCounter = mod.counter();
    segments.push({ script, base, counter });
    base += counter.nSlots;
  }
  return { segments, nSlots: base };
}

async function main(): Promise<void> {
  const { segments, nSlots } = await loadSegments();
  console.log(`${segments.length} counters, ${nSlots} slots total`);

  // Per-cell sparse accumulator: a dense scratch over the (small) combined slot space plus the
  // list of touched slots, reset per cell — no per-cell Map churn.
  const scratch = new Uint32Array(nSlots);
  let touched: number[] = [];
  const add = (base: number) => (slot: number) => {
    const g = base + slot;
    if (scratch[g] === 0) touched.push(g);
    scratch[g]++;
  };
  const adders = segments.map((s) => add(s.base));

  // Synchronous writes: the scan loop never yields to the event loop, so an async stream would
  // buffer the entire file in memory before flushing a byte.
  const out = openSync(CELL_COUNTS_BIN, "w");

  const cells: CellMeta[] = [];
  let totalNnz = 0, emissions = 0;
  const started = Date.now();

  await eachForecast((h, startHour, loc, pos, split) => {
    const ctx = makeCellCtx(h, startHour, pos);
    for (let i = 0; i < segments.length; i++)
      segments[i].counter.countCell(ctx, adders[i]);
    if (touched.length === 0) return;
    touched.sort((a, b) => a - b);
    const nnz = touched.length;
    const buf = Buffer.allocUnsafe(nnz * 6);
    for (let i = 0; i < nnz; i++) {
      const slot = touched[i];
      buf.writeUInt32LE(slot, i * 4);
      buf.writeUInt16LE(Math.min(scratch[slot], 0xffff), nnz * 4 + i * 2);
      emissions += scratch[slot];
      scratch[slot] = 0;
    }
    touched = [];
    totalNnz += nnz;
    cells.push({ id: loc, ws: h.time[0].slice(0, 13), split: split ?? "?", nnz });
    writeSync(out, buf);
    if (cells.length % 5000 === 0)
      console.log(`  ${cells.length} cells, ${(totalNnz / 1e6).toFixed(1)}M nnz, ${((Date.now() - started) / 60000).toFixed(1)} min`);
  }, "all");

  closeSync(out);

  await writeFile(CELL_COUNTS_META, JSON.stringify({
    version: 1,
    source: "best_match",
    nSlots,
    totalNnz,
    scripts: segments.map((s) => ({
      script: s.script, base: s.base,
      tables: s.counter.tables.map((t) => ({ name: t.name, dims: t.dims })),
    })),
    cells,
  }));
  console.log(`Wrote ${cells.length} cells, ${(totalNnz / 1e6).toFixed(1)}M nonzero slots ` +
    `(${(emissions / 1e6).toFixed(1)}M emissions) to ${CELL_COUNTS_BIN}`);
}

// Direct-run guard: this module is also imported (loadSegments, paths) by derive-class-ladder.ts,
// which must not trigger a re-extraction.
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => { console.error(e); process.exit(1); });
