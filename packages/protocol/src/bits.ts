export function putInt(bits: number[], value: number, n: number): void {
  for (let i = n - 1; i >= 0; i--) {
    bits.push((value >> i) & 1);
  }
}

export function takeInt(bits: number[], pos: number, n: number): [number, number] {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | (bits[pos + i] ?? 0);
  return [v, pos + n];
}

// Square-root companding for non-negative magnitudes that span a wide dynamic range
// (e.g. light hourly vs. heavy daily accumulation). Quantizes `value` to an integer code in
// [0, 2^bits - 1] as round(sqrt(value) * k): resolution is fine near zero and coarsens with
// magnitude, so a few bits cover the whole spectrum. `k` sets both precision and the largest
// representable value: valueMax = ((2^bits - 1) / k)^2.
export function compandSqrt(value: number, k: number, bits: number): number {
  if (!(value > 0)) return 0;
  return Math.min(Math.round(Math.sqrt(value) * k), (1 << bits) - 1);
}

// Inverse of compandSqrt: code → value (= (code / k)^2).
export function expandSqrt(code: number, k: number): number {
  const v = code / k;
  return v * v;
}

export function putWinds(bits: number[], ...pairs: [number, number][]): void {
  for (const [spd, dir] of pairs) {
    putInt(bits, Math.min(Math.floor(spd / 5), 15), 4);
    putInt(bits, dir % 8, 3);
  }
}

export function takeWinds(
  bits: number[],
  pos: number,
): [[number, number][], number] {
  const result: [number, number][] = [];
  for (let i = 0; i < 3; i++) {
    const [spd, p1] = takeInt(bits, pos, 4);
    const [dir, p2] = takeInt(bits, p1, 3);
    result.push([spd * 5, dir]);
    pos = p2;
  }
  return [result, pos];
}
