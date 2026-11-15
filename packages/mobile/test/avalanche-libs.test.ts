import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../../native/source-hash.mjs';

// The committed native libraries must be built from the Rust sources as they are now.
describe('avalanche native libraries', () => {
  const current = sourceHash() as string;
  it.each(['ios', 'android'])('%s libraries match the sources', (platform) => {
    const stamp = readFileSync(new URL(`../modules/avalanche/${platform}/source-hash`, import.meta.url), 'utf8').trim();
    expect(stamp, `rebuild with native/build-mobile.sh ${platform}`).toBe(current);
  });
});
