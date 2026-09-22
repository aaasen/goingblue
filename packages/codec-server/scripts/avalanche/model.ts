/**
 * Order-1 Markov model over word and separator streams, with PPM-style escapes.
 *
 * Coding a token is a ladder. Each level is a real rANS table, so falling through costs only
 * the bits of the escape symbol:
 *
 *   order-k tables  successors seen in the order-k context, plus ESC, from the stream's
 *                   highest order down to order 1; an order above 1 whose context was never
 *                   seen is skipped without cost. Words: the previous k words. Separators:
 *                   the word that follows (order 1) and the words on either side (order 2).
 *   unigram table   every token seen in this stream, plus ESC
 *   byte table      UTF-8 bytes of the literal, plus END
 *
 * Escapes use PPM exclusion on the context rungs: once a context has escaped, the symbols it
 * held cannot be the answer, so every lower context table is built without them (and without
 * them counting toward the escape weight). A lower context whose symbols are all excluded is
 * skipped without cost. The unigram rung is not excluded: rebuilding its thousands of entries
 * per escape cost ten times the throughput for a tenth of the gain.
 *
 * Escape counts follow PPM method C: a context's escape weight is its number of distinct
 * successors. A unigram table's escape weight is its hapax count, a Good-Turing estimate of the
 * chance the next word is one it has never seen. The bottom rung is over bytes, which makes the
 * codec total: any input round-trips.
 *
 * Every section kind gets its own word stream with its own vocabulary, contexts, and counts.
 * Separators are one stream used by all sections, predicted from the words around each
 * separator (BOS before the first, END after the last), and a kind table codes which section
 * comes next.
 *
 * Both sides build tables from the same stored counts in the same sorted order. That
 * determinism, not the counts themselves, is what keeps them in sync.
 */
import { buildTable, type Table } from "./rans.ts";
import type { Section } from "./text.ts";
import { tokenize } from "./tokenizer.ts";

export const ESC = 0;
export const BOS = 1;
export const UNK = 2;
export const END = 3;   // context of a section's trailing separator
const FIRST = 4;
export const LIT_END = 256;

export class Vocab {
  readonly ids = new Map<string, number>();
  readonly tokens: string[] = [];

  intern(token: string): number {
    let id = this.ids.get(token);
    if (id === undefined) {
      id = this.tokens.length + FIRST;
      this.ids.set(token, id);
      this.tokens.push(token);
    }
    return id;
  }

  token(sid: number): string {
    return this.tokens[sid - FIRST];
  }

  get size(): number {
    return this.tokens.length;
  }
}

// Escape weight for a unigram table: hapax count, at least 1.
function hapaxEscape(counts: Map<number, number>): number {
  let hapax = 0;
  for (const n of counts.values()) if (n === 1) hapax++;
  return Math.max(1, hapax);
}

const NONE: ReadonlySet<number> = new Set();

// A table over `items` minus `excluded`, with ESC weighted by the remaining distinct count
// (or `escape` when given), or null when nothing remains.
function excludingTable(
  items: [number, number][], excluded: ReadonlySet<number>, escape?: number,
): Table | null {
  const kept = excluded.size === 0 ? items : items.filter(([sid]) => !excluded.has(sid));
  if (kept.length === 0) return null;
  return buildTable([...kept, [ESC, escape ?? kept.length]]);
}

// Contexts above order 1 are keyed by the previous ids packed into one number. Ids stay below
// KEY_BASE, so a triple key stays below 2^51 and is exact in float64.
const KEY_BASE = 131072;
export const pairKey = (prev2: number, prev1: number): number => prev2 * KEY_BASE + prev1;
export const tripleKey = (prev3: number, prev2: number, prev1: number): number =>
  (prev3 * KEY_BASE + prev2) * KEY_BASE + prev1;

function bump(map: Map<number, Map<number, number>>, c: number, sid: number): void {
  let succ = map.get(c);
  if (!succ) map.set(c, (succ = new Map()));
  succ.set(sid, (succ.get(sid) ?? 0) + 1);
}

// The context keys for a token given the ids before it, highest order last.
export function chainedKeys(order: number, prev: number[]): number[] {
  const keys = [prev[0]];
  if (order >= 2) keys.push(pairKey(prev[1], prev[0]));
  if (order >= 3) keys.push(tripleKey(prev[2], prev[1], prev[0]));
  return keys;
}

export class Stream {
  // levels[k] holds the order-(k + 1) contexts: key -> successor id -> count.
  readonly levels: Map<number, Map<number, number>>[];
  readonly uni = new Map<number, number>();
  escape = 1;
  readonly vocab = new Vocab();
  private caches: Map<number, Table>[];
  private sorted: Map<number, [number, number][]>[];
  private uniTable: Table | null = null;

  // Word streams chain their own contexts; the separator stream is given explicit ones.
  constructor(readonly order: number = 1) {
    this.levels = Array.from({ length: order }, () => new Map());
    this.caches = Array.from({ length: order }, () => new Map());
    this.sorted = Array.from({ length: order }, () => new Map());
  }

  // Counts each token under its contexts: contexts[k][i] when given, else the keys chained
  // from the previous tokens.
  observe(seq: string[], contexts?: number[][]): void {
    const prev = [BOS, BOS, BOS];
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

  // Drops context successors seen fewer than minCount times, then fixes the escape weight.
  finalize(minCount = 1): void {
    if (minCount > 1) {
      for (const map of this.levels) {
        for (const [c, succ] of [...map]) {
          for (const [s, n] of [...succ]) if (n < minCount) succ.delete(s);
          if (succ.size === 0) map.delete(c);
        }
      }
    }
    this.escape = hapaxEscape(this.uni);
    for (const c of this.caches) c.clear();
    for (const c of this.sorted) c.clear();
    this.uniTable = null;
  }

  // Sorted successors of a context at `level` (0 = order 1), or null when never seen.
  successors(level: number, key: number): [number, number][] | null {
    const succ = this.levels[level].get(key);
    if (!succ) return null;
    let sorted = this.sorted[level].get(key);
    if (!sorted) {
      sorted = [...succ].sort((a, b) => a[0] - b[0]);
      this.sorted[level].set(key, sorted);
    }
    return sorted;
  }

  // The table for a context at `level` with `excluded` symbols removed. Order 1 always has a
  // table when nothing is excluded, an unseen context yielding an escape-only one; otherwise
  // null means the context was never seen or has nothing left, which both sides know, so no
  // escape is coded. Tables are cached only when nothing is excluded.
  contextTable(level: number, key: number, excluded: ReadonlySet<number> = NONE): Table | null {
    const items = this.successors(level, key);
    if (!items) {
      if (level > 0 || excluded.size > 0) return null;
      let tbl = this.caches[0].get(key);
      if (!tbl) this.caches[0].set(key, (tbl = buildTable([[ESC, 1]])));
      return tbl;
    }
    if (excluded.size > 0) return excludingTable(items, excluded);
    const cache = this.caches[level];
    let tbl = cache.get(key);
    if (!tbl) cache.set(key, (tbl = excludingTable(items, NONE)!));
    return tbl;
  }

  unigramTable(): Table {
    if (!this.uniTable) {
      const items: [number, number][] = [...this.uni].sort((a, b) => a[0] - b[0]);
      this.uniTable = excludingTable(items, NONE, this.escape)!;
    }
    return this.uniTable;
  }

  // The context to carry forward after emitting `token`.
  contextFor(token: string): number {
    return this.vocab.ids.get(token) ?? UNK;
  }
}

const utf8 = new TextEncoder();

export const WORD_ORDER = 3;
export const SEP_ORDER = 2;

export class Model {
  readonly streams = new Map<string, Stream>();
  readonly seps = new Stream(SEP_ORDER);
  // Word strings interned as separator contexts; shared across sections.
  readonly sepCtx = new Vocab();
  readonly bytes = new Map<number, number>();
  readonly kinds: string[] = [];
  private readonly kindIds = new Map<string, number>();
  private readonly kindCounts = new Map<number, number>();
  private byteTbl: Table | null = null;
  private kindTbl: Table | null = null;

  constructor(readonly wordOrder: number = WORD_ORDER) {}

  // The order-1 context of a separator: the word after it, or END for the trailing one.
  sepContextFor(nextWord: string | null): number {
    return nextWord === null ? END : (this.sepCtx.ids.get(nextWord) ?? UNK);
  }

  // A separator's context keys: the word after it, then the words on either side (BOS before
  // the first word).
  sepKeys(prevWord: string | null, nextWord: string | null): number[] {
    const next = this.sepContextFor(nextWord);
    return [next, pairKey(prevWord === null ? BOS : (this.sepCtx.ids.get(prevWord) ?? UNK), next)];
  }

  kindId(kind: string): number {
    const id = this.kindIds.get(kind);
    if (id === undefined) throw new Error(`model: unknown section kind ${kind}`);
    return id;
  }

  // The word stream a section of this kind is coded with. Kinds are fixed at training time.
  streamFor(kind: string): Stream {
    const s = this.streams.get(kind);
    if (!s) throw new Error(`model: no stream for section kind ${kind}`);
    return s;
  }

  observe(section: Section): void {
    let id = this.kindIds.get(section.kind);
    if (id === undefined) {
      id = this.kinds.length;
      this.kindIds.set(section.kind, id);
      this.kinds.push(section.kind);
    }
    this.kindCounts.set(id, (this.kindCounts.get(id) ?? 0) + 1);
    let stream = this.streams.get(section.kind);
    if (!stream) this.streams.set(section.kind, (stream = new Stream(this.wordOrder)));
    const toks = tokenize(section.text);
    stream.observe(toks.words);
    const ids = toks.words.map((w) => this.sepCtx.intern(w));
    const next = [...ids, END];
    const pairs = next.map((n, i) => pairKey(i === 0 ? BOS : ids[i - 1], n));
    this.seps.observe(toks.seps, [next, pairs]);
    for (const b of utf8.encode(section.text)) this.bytes.set(b, (this.bytes.get(b) ?? 0) + 1);
  }

  finalize(minCount = 1): void {
    for (const s of this.streams.values()) s.finalize(minCount);
    this.seps.finalize(minCount);
    this.byteTbl = null;
    this.kindTbl = null;
  }

  kindTable(): Table {
    if (!this.kindTbl) {
      const items: [number, number][] = [...this.kindCounts].sort((a, b) => a[0] - b[0]);
      this.kindTbl = buildTable(items);
    }
    return this.kindTbl;
  }

  // Every byte value stays representable even if unseen; literals average about six bytes,
  // which sets the terminator's weight.
  byteTable(): Table {
    if (!this.byteTbl) {
      let total = 0;
      for (const n of this.bytes.values()) total += n;
      const items: [number, number][] = [];
      for (let b = 0; b < 256; b++) items.push([b, (this.bytes.get(b) ?? 0) + 1]);
      items.push([LIT_END, Math.max(1, Math.floor(Math.max(1, total) / 6))]);
      this.byteTbl = buildTable(items);
    }
    return this.byteTbl;
  }

  // Rough ship weight: vocabulary and context entries per order, summed over word streams.
  stats(): { streams: number; wordVocab: number; entries: number[]; contexts: number[] } {
    let vocab = 0;
    const entries: number[] = [];
    const contexts: number[] = [];
    for (const s of this.streams.values()) {
      vocab += s.vocab.size;
      s.levels.forEach((map, level) => {
        contexts[level] = (contexts[level] ?? 0) + map.size;
        let n = 0;
        for (const succ of map.values()) n += succ.size;
        entries[level] = (entries[level] ?? 0) + n;
      });
    }
    return { streams: this.streams.size, wordVocab: vocab, entries, contexts };
  }
}
