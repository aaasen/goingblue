---
name: benchmark
description: Regenerate the public encoding benchmark at going.blue/benchmark
---

1. Check that the working tree is clean with `git status`.
2. Ensure that the corpus has data with `pnpm benchmark --dry-run --source best_match`. It should report zero planned calls. If it does not, ask the user if they would like to proceed with missing data or fill in data with `pnpm benchmark --collect-only --source best_match`.
3. Generate a new benchmark with `pnpm benchmark --report-only`. This will open the benchmark in the browser when done for the user to review.
4. Wait for approval to publish the benchmark.
5. After receiving approval, compress the benchmark. The benchmark is at `data/benchmarks/<timestamp>_160c.html`, which is gitignored. First, check the size of the old file. Then, compress the new file with `gzip -9 -c data/benchmarks/<run>.html > packages/server/public/benchmark.html.gz`. Check that the size of the new compressed file is similar to the old one. Alert the user if it differs considerably.
6. Uncompress the file and make sure that it matches the original benchmark. 
7. Ensure that only the benchmark file has changed then commit the change with the message "Update public codec benchmark". 
8. Tell the user that the benchmark has been updated and committed. Do not push or deploy the change.
