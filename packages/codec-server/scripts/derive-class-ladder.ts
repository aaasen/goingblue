/**
 * Codebook-class ladder: learn K per-message-selectable codebook classes by Lloyd's/EM in
 * code-length space, and measure what each K buys on the held-out eval split.
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-class-ladder.ts [--k 2,4,8] [--alpha 200] [--iters 25]
 *
 * Runs on the per-cell sparse counts precomputed by extract-cell-counts.ts (run that first).
 * The unit is one forecast cell (location × window, message-shaped — a location's winter and
 * summer can land in different classes). Cost(cell, class) = Σ counts · costBits(class tables) —
 * the exact model cost the encoder's try-all-pick-best would compare, so the E-step IS
 * production's selector. The selector itself is free on the wire up to 3 bits (V3_HEADER_BITS
 * 22 → 25 still fits the 4 base-85 header chars).
 *
 *   - Class 0 is PINNED to the global (train-corpus-wide) tables: the fallback that guarantees
 *     no cell can encode worse than today, and keeps class numbering anchored.
 *   - M-step smoothing shrinks each class row toward the global row: smoothed = classCounts +
 *     alpha · P_global(row) — load-bearing, or K-way data fragmentation blows up sparse rows.
 *   - Classes that go empty/weak are reseeded from the worst-encoded cells under the current
 *     model (hunts underserved regimes).
 *   - The ladder K = 2 → 4 → 8 warm-starts each K from the previous one's classes, growing by
 *     seeding new classes from the worst-encoded cells, then re-running EM.
 *
 * Eval cells (the 15% held-out sampled sites, favorites, peaks) never influence the classes;
 * they are scored best-of-K, exactly as the encoder would. Everything is deterministic — no RNG.
 *
 * Results (per-K assignments + eval summaries) land in data/class-ladder.json.
 *
 * --emit rebuilds the FINAL K's per-class table sets from the saved assignments (deterministic,
 * no EM re-run) and writes packages/protocol/src/codebooks-classes.gen.ts — classes 1..K-1's
 * weight tables (class 0 is the base codebooks.gen.ts set), built from the same smoothed counts
 * the ladder evaluated, through each derive script's own tablesFrom. Re-run the whole pipeline
 * (pnpm generate → extract-cell-counts → this script → this script --emit) whenever the corpus
 * or a derive script changes: the class tables must stay in sync with the class-0 tables.
 */
import { readFile, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { openDb, dbLocations, REPO_ROOT } from "./corpus-db.ts";
import { loadSegments, CELL_COUNTS_BIN, CELL_COUNTS_META, type CellMeta } from "./extract-cell-counts.ts";
import type { DerivedTables } from "./derive-lib.ts";

const OUT_PATH = join(REPO_ROOT, "data", "class-ladder.json");
const EMIT_PATH = join(REPO_ROOT, "packages", "protocol", "src", "codebooks-classes.gen.ts");

// ── CLI ─────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const KS = flag("k", "2,4,8").split(",").map(Number);
const ALPHA = Number(flag("alpha", "200"));
const MAX_ITERS = Number(flag("iters", "25"));
const SEED_FRAC = 0.1;       // worst-encoded fraction that seeds a new/reseeded class
const WEAK_FRAC = 0.005;     // a class below this share of train cells is reseeded
const CONVERGED_FRAC = 0.001; // stop when fewer than this fraction of cells move

// ── Load counts ─────────────────────────────────────────────────────────────────
interface Meta {
  nSlots: number; totalNnz: number;
  scripts: { script: string; base: number; tables: { name: string; dims: number[] }[] }[];
  cells: CellMeta[];
}

async function loadCounts(meta: Meta): Promise<{ slots: Uint32Array; counts: Uint16Array; starts: Float64Array }> {
  const slots = new Uint32Array(meta.totalNnz);
  const counts = new Uint16Array(meta.totalNnz);
  const starts = new Float64Array(meta.cells.length + 1);
  const fh = await open(CELL_COUNTS_BIN, "r");
  let nnzDone = 0;
  const buf = Buffer.allocUnsafe(1 << 22);
  let bufLen = 0, bufPos = 0, filePos = 0;
  const need = async (n: number): Promise<Buffer> => {
    if (bufLen - bufPos < n) {
      buf.copyWithin(0, bufPos, bufLen);
      bufLen -= bufPos; bufPos = 0;
      const { bytesRead } = await fh.read(buf, bufLen, buf.length - bufLen, filePos);
      filePos += bytesRead; bufLen += bytesRead;
      if (bufLen < n) throw new Error("cell-counts.bin truncated");
    }
    const b = buf.subarray(bufPos, bufPos + n);
    bufPos += n;
    return b;
  };
  for (let c = 0; c < meta.cells.length; c++) {
    const nnz = meta.cells[c].nnz;
    starts[c] = nnzDone;
    const b = await need(nnz * 6);
    for (let i = 0; i < nnz; i++) {
      slots[nnzDone + i] = b.readUInt32LE(i * 4);
      counts[nnzDone + i] = b.readUInt16LE(nnz * 4 + i * 2);
    }
    nnzDone += nnz;
  }
  starts[meta.cells.length] = nnzDone;
  await fh.close();
  return { slots, counts, starts };
}

async function main(): Promise<void> {
  const meta: Meta = JSON.parse(await readFile(CELL_COUNTS_META, "utf8"));
  const { segments, nSlots } = await loadSegments();
  if (nSlots !== meta.nSlots) throw new Error(`slot space drifted: counters ${nSlots} vs extracted ${meta.nSlots} — re-run extract-cell-counts.ts`);
  console.log(`${meta.cells.length} cells, ${(meta.totalNnz / 1e6).toFixed(1)}M nnz, ${nSlots} slots`);
  const { slots, counts, starts } = await loadCounts(meta);

  // Location metadata for split/stratum reporting.
  const db = openDb();
  const locs = dbLocations(db);
  db.close();
  const bandLabel = (south: number): string => {
    const edge = (d: number) => `${Math.abs(d)}°${d < 0 ? "S" : d > 0 ? "N" : ""}`;
    return `ocean ${edge(south)}–${edge(south + 30)}`;
  };
  const peakBand = (elevM: number): string =>
    elevM >= 5500 ? "peaks ≥5.5 km" : elevM >= 3500 ? "peaks 3.5–5.5 km" : "peaks <3.5 km";
  const groupOf = (id: string): string => {
    const loc = locs.get(id);
    if (!loc) return "?";
    if (loc.stratum === "favorites") return "favorites";
    if (loc.stratum === "peaks") return peakBand(loc.elev_m ?? 0);
    if (loc.stratum === "ocean") return bandLabel(Math.min(2, Math.floor(loc.lat / 30)) * 30);
    return `Köppen ${loc.koppen?.[0] ?? "?"}`;
  };

  const trainIdx: number[] = [], evalIdx: number[] = [];
  meta.cells.forEach((c, i) => (c.split === "train" ? trainIdx : evalIdx).push(i));
  console.log(`train ${trainIdx.length} cells, eval ${evalIdx.length} cells`);

  // ── Cost machinery ────────────────────────────────────────────────────────────
  // Per-slot bit costs of the table set a count vector would ship (each segment's costBits is
  // the derive script's own — quantization/fallbacks identical to the shipped tables).
  const costOf = (vec: Float64Array): Float64Array => {
    const L = new Float64Array(nSlots);
    for (const s of segments)
      L.set(s.counter.costBits(vec.subarray(s.base, s.base + s.counter.nSlots)), s.base);
    return L;
  };
  const cellBits = (cell: number, L: Float64Array): number => {
    let b = 0;
    for (let i = starts[cell]; i < starts[cell + 1]; i++) b += counts[i] * L[slots[i]];
    return b;
  };
  const addCellInto = (cell: number, vec: Float64Array) => {
    for (let i = starts[cell]; i < starts[cell + 1]; i++) vec[slots[i]] += counts[i];
  };

  // Global (class 0) tables: all train cells.
  const globalCounts = new Float64Array(nSlots);
  for (const c of trainIdx) addCellInto(c, globalCounts);

  // Row layout (for smoothing): [start, nsym) of every counted-table row.
  const rows: { start: number; n: number }[] = [];
  for (const s of meta.scripts) {
    let off = s.base;
    for (const t of s.tables) {
      const nsym = t.dims[t.dims.length - 1];
      const nRows = t.dims.slice(0, -1).reduce((a, b) => a * b, 1);
      for (let r = 0; r < nRows; r++) { rows.push({ start: off, n: nsym }); off += nsym; }
    }
  }
  // Global per-row distributions, precomputed for the smoother.
  const globalRowDist = new Float64Array(nSlots);
  for (const { start, n } of rows) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += globalCounts[start + i];
    if (sum > 0) for (let i = 0; i < n; i++) globalRowDist[start + i] = globalCounts[start + i] / sum;
  }
  const smoothWith = (raw: Float64Array, alpha: number): Float64Array => {
    const out = new Float64Array(raw);
    for (let i = 0; i < nSlots; i++) out[i] += alpha * globalRowDist[i];
    return out;
  };
  const smooth = (raw: Float64Array): Float64Array => smoothWith(raw, ALPHA);

  // ── --emit: write codebooks-classes.gen.ts from the saved final-K assignments ─
  if (argv.includes("--emit")) {
    const ladder = JSON.parse(await readFile(flag("from", OUT_PATH), "utf8"));
    const final = ladder.assignments[ladder.assignments.length - 1];
    const K: number = final.K;
    const assign: number[] = final.assign;
    if (assign.length !== trainIdx.length)
      throw new Error(`assignments cover ${assign.length} train cells, extract has ${trainIdx.length} — re-run the ladder`);
    const classCounts = Array.from({ length: K }, () => new Float64Array(nSlots));
    trainIdx.forEach((c, i) => { if (assign[i] > 0) addCellInto(c, classCounts[assign[i]]); });
    const sets: DerivedTables[] = [];
    for (let k = 1; k < K; k++) {
      const sm = smoothWith(classCounts[k], ladder.alpha);
      const set: DerivedTables = {};
      for (const s of segments)
        Object.assign(set, s.counter.tablesFrom(sm.subarray(s.base, s.base + s.counter.nSlots)));
      sets.push(set);
    }
    const names = Object.keys(sets[0]);
    const depth = (t: unknown): number => (Array.isArray(t) ? 1 + depth(t[0]) : 0);
    const renderVal = (t: any, indent: string): string =>
      !Array.isArray(t[0]) ? `[${t.join(", ")}]`
        : `[\n${t.map((x: any) => `${indent}  ${renderVal(x, indent + "  ")},`).join("\n")}\n${indent}]`;
    const iface = names.map((n) => `  ${n}: ${"number" + "[]".repeat(depth(sets[0][n]))};`).join("\n");
    const classes = sets.map((set, i) =>
      `  { // class ${i + 1}\n${names.map((n) => `    ${n}: ${renderVal(set[n], "    ")},`).join("\n")}\n  },`).join("\n");
    const base = ladder.results[0].evalBits, last = ladder.results[ladder.results.length - 1].evalBits;
    const header = `// GENERATED FILE — do not edit by hand. Written by derive-class-ladder.ts --emit
// (packages/codec-server/scripts/derive-class-ladder.ts): per-class codebook weight tables, learned by
// EM in code-length space over the train corpus (alpha=${ladder.alpha}, held-out eval ${
      (100 * (last - base) / base).toFixed(2)}% body bits vs the single
// global table set). Class 0 is the base set in codebooks.gen.ts and is NOT repeated here;
// classes 1..${K - 1} below are selected per message by the encoder's try-all-pick-best and carried
// in the v3 header's 3-bit selector. These tables are v3 wire format (digest-pinned alongside
// the base set in test/codebooks.test.ts) and must be regenerated IN SYNC with codebooks.gen.ts:
// pnpm generate → extract-cell-counts.ts → derive-class-ladder.ts → derive-class-ladder.ts --emit.
`;
    await writeFile(EMIT_PATH, `${header}
export interface ClassTableSet {
${iface}
}

// Codebook classes on the wire, INCLUDING class 0 (the base codebooks.gen.ts set).
export const CODEBOOK_CLASSES = ${K};

export const CLASS_TABLES: ClassTableSet[] = [
${classes}
];
`);
    console.log(`Wrote ${K - 1} class table sets (classes 1..${K - 1}) to ${EMIT_PATH}`);
    return;
  }

  const L0 = costOf(globalCounts);

  // Per-cell emission totals (badness normalizer for seeding).
  const cellEmissions = new Float64Array(meta.cells.length);
  for (let c = 0; c < meta.cells.length; c++) {
    let e = 0;
    for (let i = starts[c]; i < starts[c + 1]; i++) e += counts[i];
    cellEmissions[c] = e;
  }

  // ── EM ────────────────────────────────────────────────────────────────────────
  // costs[c] under the current class set is maintained across seeding/reseeding.
  const seedFromWorst = (Ls: Float64Array[], exclude: Set<number>): Float64Array => {
    // Worst-encoded train cells (bits/emission under current best-of) seed a new class.
    const badness = trainIdx
      .filter((c) => !exclude.has(c))
      .map((c) => {
        let best = Infinity;
        for (const L of Ls) best = Math.min(best, cellBits(c, L));
        return { c, b: best / Math.max(1, cellEmissions[c]) };
      })
      .sort((a, b) => b.b - a.b || a.c - b.c);
    const take = badness.slice(0, Math.max(1, Math.floor(trainIdx.length * SEED_FRAC)));
    const vec = new Float64Array(nSlots);
    for (const { c } of take) { addCellInto(c, vec); exclude.add(c); }
    return smooth(vec);
  };

  interface EmResult { K: number; Ls: Float64Array[]; assign: Int16Array; classCounts: Float64Array[] }

  const runEM = (K: number, warmLs: Float64Array[]): EmResult => {
    // Start from the warm class set, growing to K by seeding from worst-encoded cells.
    const Ls: Float64Array[] = warmLs.slice(0, K);
    const seeded = new Set<number>();
    while (Ls.length < K) Ls.push(costOf(seedFromWorst(Ls, seeded)));

    const assign = new Int16Array(meta.cells.length).fill(-1);
    let classCounts: Float64Array[] = [];
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      // E-step: production's try-all-pick-best.
      let moved = 0;
      const sizes = new Array<number>(K).fill(0);
      let objective = 0;
      for (const c of trainIdx) {
        let best = 0, bestBits = cellBits(c, Ls[0]);
        for (let k = 1; k < K; k++) {
          const b = cellBits(c, Ls[k]);
          if (b < bestBits) { bestBits = b; best = k; }
        }
        if (assign[c] !== best) { moved++; assign[c] = best; }
        sizes[best]++;
        objective += bestBits;
      }
      console.log(`  K=${K} iter ${iter}: train ${(objective / trainIdx.length).toFixed(1)} bits/cell, ` +
        `moved ${moved}, sizes [${sizes.join(", ")}]`);

      // M-step: refit classes 1..K-1 (class 0 pinned to global); reseed weak classes.
      classCounts = Array.from({ length: K }, () => new Float64Array(nSlots));
      classCounts[0] = globalCounts;
      for (const c of trainIdx) if (assign[c] > 0) addCellInto(c, classCounts[assign[c]]);
      const reseedExclude = new Set<number>();
      for (let k = 1; k < K; k++) {
        if (sizes[k] < trainIdx.length * WEAK_FRAC) {
          console.log(`  K=${K} iter ${iter}: class ${k} weak (${sizes[k]} cells) — reseeding from worst-encoded`);
          classCounts[k] = seedFromWorst(Ls, reseedExclude);
          Ls[k] = costOf(classCounts[k]);
        } else {
          classCounts[k] = smooth(classCounts[k]);
          Ls[k] = costOf(classCounts[k]);
        }
      }
      if (moved <= trainIdx.length * CONVERGED_FRAC && iter > 0) break;
    }
    return { K, Ls, assign, classCounts };
  };

  // ── Eval scoring ─────────────────────────────────────────────────────────────
  interface EvalStats { totalBits: number; byGroup: Map<string, { bits: number; cells: number }>; pick: number[] }
  const scoreEval = (Ls: Float64Array[]): EvalStats => {
    let totalBits = 0;
    const byGroup = new Map<string, { bits: number; cells: number }>();
    const pick = new Array<number>(Ls.length).fill(0);
    for (const c of evalIdx) {
      let best = 0, bestBits = cellBits(c, Ls[0]);
      for (let k = 1; k < Ls.length; k++) {
        const b = cellBits(c, Ls[k]);
        if (b < bestBits) { bestBits = b; best = k; }
      }
      pick[best]++;
      totalBits += bestBits;
      const g = groupOf(meta.cells[c].id);
      const e = byGroup.get(g) ?? { bits: 0, cells: 0 };
      e.bits += bestBits; e.cells++;
      byGroup.set(g, e);
    }
    return { totalBits, byGroup, pick };
  };

  // Per-script (variable family) eval bits under best-of-K, for the oracle-gap-by-variable view.
  const scoreEvalByScript = (Ls: Float64Array[]): Map<string, number> => {
    const segOf = new Uint8Array(nSlots);
    segments.forEach((s, i) => segOf.fill(i, s.base, s.base + s.counter.nSlots));
    const perScript = new Float64Array(segments.length);
    for (const c of evalIdx) {
      let best = 0, bestBits = cellBits(c, Ls[0]);
      for (let k = 1; k < Ls.length; k++) {
        const b = cellBits(c, Ls[k]);
        if (b < bestBits) { bestBits = b; best = k; }
      }
      const L = Ls[best];
      for (let i = starts[c]; i < starts[c + 1]; i++) perScript[segOf[slots[i]]] += counts[i] * L[slots[i]];
    }
    return new Map(segments.map((s, i) => [s.script.replace("derive-", "").replace("-codebooks", ""), perScript[i]]));
  };

  // ── The ladder ────────────────────────────────────────────────────────────────
  const base = scoreEval([L0]);
  const baseByScript = scoreEvalByScript([L0]);
  console.log(`\nK=1 (global): eval ${(base.totalBits / evalIdx.length).toFixed(1)} bits/cell`);

  const fmtPct = (now: number, ref: number) => `${(100 * (now - ref) / ref).toFixed(2)}%`;
  const results: any[] = [{ K: 1, evalBits: base.totalBits }];
  let warm: Float64Array[] = [L0];
  let prevBits = base.totalBits;
  let em: EmResult | null = null;
  const emByK: EmResult[] = [];

  for (const K of KS) {
    console.log(`\n── K=${K} ${"─".repeat(60)}`);
    em = runEM(K, warm);
    emByK.push(em);
    const ev = scoreEval(em.Ls);
    const evScript = scoreEvalByScript(em.Ls);
    console.log(`K=${K}: eval ${(ev.totalBits / evalIdx.length).toFixed(1)} bits/cell — ` +
      `${fmtPct(ev.totalBits, base.totalBits)} vs global, ${fmtPct(ev.totalBits, prevBits)} vs previous K`);
    console.log(`  eval class picks: [${ev.pick.join(", ")}]`);
    console.log(`  by stratum (Δ vs global):`);
    for (const [g, e] of [...ev.byGroup.entries()].sort()) {
      const b = base.byGroup.get(g)!;
      console.log(`    ${g.padEnd(18)} ${(e.bits / e.cells).toFixed(0).padStart(7)} bits/cell  ${fmtPct(e.bits, b.bits)}`);
    }
    console.log(`  by variable family (Δ vs global):`);
    for (const [s, bits] of evScript) {
      console.log(`    ${s.padEnd(18)} ${fmtPct(bits, baseByScript.get(s)!)}`);
    }
    results.push({
      K,
      evalBits: ev.totalBits,
      evalPick: ev.pick,
      byGroup: Object.fromEntries([...ev.byGroup.entries()].map(([g, e]) => [g, e])),
      byScript: Object.fromEntries(evScript),
    });
    prevBits = ev.totalBits;
    warm = em.Ls;
  }

  await writeFile(OUT_PATH, JSON.stringify({
    alpha: ALPHA, ks: KS,
    evalCells: evalIdx.length, trainCells: trainIdx.length,
    results,
    // Final K's train assignments, for the wire-in derivation (cells in extract order).
    assignments: emByK.map((r) => ({
      K: r.K,
      assign: trainIdx.map((c) => r.assign[c]),
    })),
  }));
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
