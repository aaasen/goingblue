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
    [56, 56, 89, 214, 1],
    [758, 200, 101, 32, 1],
    [190, 398, 280, 102, 1],
    [147, 263, 622, 282, 1],
    [49, 122, 300, 2335, 1],
    [1, 1, 1, 1, 1],
  ],
  [ // 1
    [1, 1, 1, 1, 1],
    [441, 201, 161, 73, 1],
    [203, 222, 186, 101, 1],
    [175, 193, 300, 144, 1],
    [82, 95, 148, 1401, 1],
    [1, 1, 1, 1, 1],
  ],
  [ // 2
    [1, 1, 1, 1, 1],
    [840, 261, 153, 114, 1],
    [273, 163, 126, 90, 1],
    [187, 115, 109, 74, 1],
    [103, 85, 72, 1361, 1],
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
