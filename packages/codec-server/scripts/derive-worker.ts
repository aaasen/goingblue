/**
 * One shard of the corpus scan, run as a child process by generate-codebooks.ts.
 *
 * The counting is embarrassingly parallel — every cell contributes independently to a flat vector
 * of integer counts — so the corpus is split by cell and each shard sums its own vectors. The
 * parent adds them. Integer counts add associatively, so the total is bit-identical to a
 * single-process run whatever order the shards finish in; parallelism here can't move a codebook.
 *
 * Invoked as:  tsx derive-worker.ts <shardIndex> <shardTotal> <outPath> <script...>
 *
 * The scripts are named explicitly rather than re-discovered, so the parent's ordering is what
 * defines the layout of the output file: each counter's Float64Array written back to back, in the
 * order the scripts were passed.
 */
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { deriveCountsMulti, type CellCounter } from "./derive-lib.ts";

const [shardIndex, shardTotal, outPath, ...scripts] = process.argv.slice(2);
const dir = dirname(fileURLToPath(import.meta.url));

const counters: CellCounter[] = [];
for (const script of scripts) {
  const mod = await import(pathToFileURL(join(dir, script)).href);
  counters.push(mod.counter());
}

const vecs = await deriveCountsMulti(counters, {
  index: Number(shardIndex), total: Number(shardTotal),
});

// Raw Float64 buffers back to back. The parent knows each counter's length from its own copy of
// the counters, so the file carries no header.
const fd = openSync(outPath, "w");
try {
  for (const v of vecs) writeSync(fd, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
} finally {
  closeSync(fd);
}
