// GENERATED FILE, do not edit by hand. Written by `pnpm generate`
// (packages/codec-server/scripts/generate-codebooks.ts).
// Source: scripts/derive-model-agreement-codebooks.ts
// Last changed: 2026-09-13
// Integer weight tables derived from the corpus in data/corpus.db. These tables are wire
// format: regenerating changes what already-encoded messages mean, so test/codebooks.test.ts
// pins their digest. See packages/protocol/src/entropy.ts for how each table is used and the
// derive script for methodology.

export const AGREEMENT_WEIGHTS_BY_LEAD: number[][][] = [
  [ // 0
    [75, 78, 137, 262, 1],
    [1088, 277, 158, 51, 1],
    [273, 584, 383, 144, 1],
    [211, 384, 899, 395, 1],
    [68, 172, 413, 2736, 1],
    [1, 1, 1, 1, 1],
  ],
  [ // 1
    [1, 1, 1, 1, 1],
    [673, 311, 213, 106, 1],
    [308, 331, 262, 148, 1],
    [240, 254, 366, 195, 1],
    [125, 141, 202, 1621, 1],
    [1, 1, 1, 1, 1],
  ],
  [ // 2
    [1, 1, 1, 1, 1],
    [970, 296, 184, 143, 1],
    [330, 200, 158, 112, 1],
    [229, 158, 135, 99, 1],
    [141, 106, 100, 1450, 1],
    [1, 1, 1, 1, 1],
  ],
  [ // 3
    [1, 1, 1, 1, 1],
    [789, 141, 62, 66, 10],
    [143, 48, 27, 23, 2],
    [64, 25, 27, 21, 2],
    [41, 22, 21, 1499, 1],
    [1, 1, 1, 1, 1],
  ],
];
