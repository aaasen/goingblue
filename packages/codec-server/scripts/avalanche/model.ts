/**
 * Training for the avalanche prose model: counts tokens under their contexts in Maps, then
 * builds the read-only Model the codec runs on (packages/protocol/src/avalanche-codec/model.ts),
 * whose counts are sorted typed arrays.
 */
import {
  BOS, END, KEY_BASE, Model, Stream, Vocab, chainedKeys, contextMarker, pairKey,
  type Counts, type Ids, type Keys, type Level, type Section,
} from "@weather/protocol/avalanche-codec/model";
import { tokenize } from "@weather/protocol/avalanche-codec/tokenizer";

export const WORD_ORDER = 3;
export const SEP_ORDER = 2;

const utf8 = new TextEncoder();

function bump(map: Map<number, Map<number, number>>, c: number, sid: number): void {
  let succ = map.get(c);
  if (!succ) map.set(c, (succ = new Map()));
  succ.set(sid, (succ.get(sid) ?? 0) + 1);
}

// The narrowest typed arrays that hold the values exactly.
const keysOf = (v: number[]): Keys => (v.every((k) => k < 2 ** 32) ? Uint32Array.from(v) : Float64Array.from(v));
const idsOf = (v: number[]): Ids => (v.every((n) => n < 65536) ? Uint16Array.from(v) : Uint32Array.from(v));
const countsOf = (v: number[]): Counts => (v.every((n) => n < 65536) ? Uint16Array.from(v) : Uint32Array.from(v));

export class StreamBuilder {
  // levels[k] holds the order-(k + 1) contexts: key -> successor id -> count.
  readonly levels: Map<number, Map<number, number>>[];
  readonly uni = new Map<number, number>();
  readonly vocab = new Vocab();

  // Word streams chain their own contexts; the separator stream is given explicit ones.
  constructor(readonly order: number = 1) {
    this.levels = Array.from({ length: order }, () => new Map());
  }

  // Counts each token under its contexts: contexts[k][i] when given, else the keys chained
  // from the previous tokens, starting from `start`.
  observe(seq: string[], contexts?: number[][], start: number = BOS): void {
    const prev = [start, BOS, BOS];
    for (let i = 0; i < seq.length; i++) {
      const sid = this.vocab.intern(seq[i]);
      if (sid >= KEY_BASE) throw new Error("model: vocabulary exceeds the context key base");
      const keys = contexts ? contexts.map((c) => c[i]) : chainedKeys(this.order, prev);
      keys.forEach((k, level) => bump(this.levels[level], k, sid));
      this.uni.set(sid, (this.uni.get(sid) ?? 0) + 1);
      prev.unshift(sid);
      prev.pop();
    }
  }

  // The read-only stream, dropping context successors seen fewer than minCount times.
  build(minCount = 1): Stream {
    const levels: Level[] = this.levels.map((map) => {
      const keys: number[] = [];
      const offsets = [0];
      const sids: number[] = [];
      const counts: number[] = [];
      for (const [key, succ] of [...map].sort((a, b) => a[0] - b[0])) {
        const kept = [...succ].filter(([, n]) => n >= minCount).sort((a, b) => a[0] - b[0]);
        if (kept.length === 0) continue;
        keys.push(key);
        for (const [sid, n] of kept) {
          sids.push(sid);
          counts.push(n);
        }
        offsets.push(sids.length);
      }
      return { keys: keysOf(keys), offsets: Uint32Array.from(offsets), sids: idsOf(sids), counts: countsOf(counts) };
    });
    const uni = [...this.uni].sort((a, b) => a[0] - b[0]);
    return new Stream(this.vocab, levels, { sids: idsOf(uni.map(([s]) => s)), counts: countsOf(uni.map(([, n]) => n)) });
  }
}

export class ModelBuilder {
  readonly streams = new Map<string, StreamBuilder>();
  readonly seps = new StreamBuilder(SEP_ORDER);
  readonly sepCtx = new Vocab();
  readonly bytes = new Array<number>(256).fill(0);
  readonly kinds: string[] = [];
  readonly kindCounts: number[] = [];

  constructor(readonly wordOrder: number = WORD_ORDER) {}

  observe(section: Section): void {
    let id = this.kinds.indexOf(section.kind);
    if (id === -1) {
      id = this.kinds.length;
      this.kinds.push(section.kind);
      this.kindCounts.push(0);
    }
    this.kindCounts[id]++;
    let stream = this.streams.get(section.kind);
    if (!stream) this.streams.set(section.kind, (stream = new StreamBuilder(this.wordOrder)));
    const toks = tokenize(section.text);
    // A section with a context starts from its marker, interned as a context-only id.
    const start = section.context === undefined ? BOS : stream.vocab.intern(contextMarker(section.context));
    stream.observe(toks.words, undefined, start);
    const ids = toks.words.map((w) => this.sepCtx.intern(w));
    const next = [...ids, END];
    const pairs = next.map((n, i) => pairKey(i === 0 ? BOS : ids[i - 1], n));
    this.seps.observe(toks.seps, [next, pairs]);
    for (const b of utf8.encode(section.text)) this.bytes[b]++;
  }

  build(minCount = 1): Model {
    return new Model({
      wordOrder: this.wordOrder,
      streams: new Map([...this.streams].map(([kind, s]) => [kind, s.build(minCount)])),
      seps: this.seps.build(minCount),
      sepCtx: this.sepCtx,
      kinds: this.kinds,
      kindCounts: this.kindCounts,
      byteCounts: this.bytes,
    });
  }
}
