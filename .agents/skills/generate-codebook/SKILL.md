---
name: generate-codebook
description: Generate a codebook
---

Codebooks are the probability distributions that power the rANS entropy coder. They are shared by the client and server. The server and client need to use the exact same codebooks for a message to be decoded, so the codebooks are versioned with the rest of the codec. Codebooks can only be re-generated if the codec version is not frozen (no goldens exist). See the `codec-version` skill for more information on codec versioning. 

The steps for generating a codebook are:
1. Ensure that the data is available in the corpus.
2. Decide what conditioning to use by analyzing the entropy of the data with various conditioning approaches. The goal is to reduce entropy without using too many codebooks.
3. Generate the codebooks.

## Corpus Data

Codebooks are trained from the corpus in `data/corpus.db` which is a SQLite database of Open-Meteo forecast data. Only the `train` locations are used for codebook generation. The `best_match` model is used for codebook generation. 

If the variable is new, add it to the `best_match` collect list in `benchmark.ts`.

To make sure that the corpus has all of the necessary data, run `pnpm benchmark --dry-run --source best_match` and ensure that there are no planned calls.

If there are planned calls, ask the user if they want to run corpus collection with `pnpm benchmark --collect-only --source best_match`. If the number of planned calls exceeds 10k (Open-Meteo free tier limit), ensure that the `OPEN_METEO_API_KEY` is set.

Always run these checks from the main checkout, not a worktree. The corpus is gitignored so it will not be available in a worktree. 

## Entropy Reduction

The encoder can use existing context to reduce the entropy of the data. For example, the weathercode uses the weathercode of the previous period. Temperature uses local time of day. The README explains the context used by each variable. 

The `packages/codec-server/scripts/analyze/<name>.ts` scripts, one per derive codebook, analyze the entropy of different conditioning techniques. Each exports `analyze(args)` and reports held-out cost, 5-fold by location, as a ladder of candidate contexts with the shipped rung marked. They share `analyze/lib.ts`: `eachColumn` walks the corpus with the same local-midnight aggregation the derive scripts train on, `heldOut` prices one scheme, and `printLadder` reports it. Run one with `pnpm exec tsx packages/codec-server/scripts/analyze/<name>.ts`; `--stride N` scans one train cell in N for a quick look. When adding a new variable, add it to `DERIVE_VARS` in `derive-lib.ts` and add a script here following the existing patterns. Ask the user for input on what should be used for conditioning. 

Some guidelines:
1. The context must be available to the decoder for the symbol. Forecast resolution, local time of day, elevation, or variables already decoded.
2. Each context multiplies the table count, shrinks the number of samples per row, and adds bytes to the app bundle. Aim for the point of diminishing returns and keep the number of tables per variable under 1,000. 
3. Training must mirror the wire exactly. Adjust framing to local midnight, use the same quantization, and use the same corrections as `eachForecast` applies. 
4. Present several different options to the user so that they can decide how the column should be conditioned.

## Codebook Generation

Each codebook has a derive script at `packages/codec-server/scripts/derive-<name>-codebooks.ts` that exports `counter()` and `derive()`. `pnpm generate` automatically runs these scripts and writes the resulting codebooks to `packages/protocol/src/codebooks/<name>.gen.ts`.

Run `pnpm exec tsx packages/codec-server/scripts/derive-<name>-codebooks.ts` to print tables and stats without writing.

For new variables, add the table to `BASE_TABLES` in `entropy.ts` and consume it in the encoder and decoder in `wire.ts`. A table outside `WIRE_CODEBOOKS` is not covered by the digest test.

Generate the codebooks with `pnpm generate --only <name>` for a single variable or `pnpm generate` for all. The generation should take about 1-3 minutes for a single variable or about 5 minutes for all. Ensure that only the expected tables are changed.

## Fixture and Digest Generation

After a codebook is regenerated, the fixtures need to be updated:

```
pnpm --filter @weather/protocol build
pnpm exec tsx packages/protocol/scripts/generate-fixture.ts
pnpm test
```

This will fail because the digest is out of date. It will print the new digest. Set `FROZEN_DIGEST` to the new digest.

## Benchmark

Each codebook generation should improve the benchmark. Generate a benchmark for a single location with `pnpm benchmark --report-only --location <location>`, e.g. `denali`. Run the benchmark on the entire corpus with `pnpm benchmark --report-only`. See the `benchmark` skill for updating the public benchmark.

## Publishing

After a codebook is regenerated, make sure the README's table of variable conditioning is updated. Never update the README directly but flag it to the user.
