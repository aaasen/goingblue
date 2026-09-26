/**
 * Markov model over word and separator streams, with PPM-style escapes.
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
 * A section with a context (a problem description's type) starts its word contexts from a
 * marker for that context instead of BOS, so its first words are predicted from the type.
 * Separators are one stream used by all sections, predicted from the words around each
 * separator (BOS before the first, END after the last), and a kind table codes which section
 * comes next.
 *
 * The counts are read-only here, held as sorted typed arrays so a trained model loads without
 * parsing (see pack.ts); training lives in the codec server's scripts. Both sides build tables
 * from the same stored counts in the same sorted order. That determinism, not the counts
 * themselves, is what keeps them in sync.
 */
import { buildTable, type Table } from "./rans.js";

export const ESC = 0;
export const BOS = 1;
export const UNK = 2;
export const END = 3;   // context of a section's trailing separator
export const FIRST = 4;
export const LIT_END = 256;

export interface Section {
  kind: string;   // see SECTION_KINDS in bulletin.ts
  text: string;
  context?: string;   // problem type for a problem description; the word model starts from it
}

export class Vocab {
  readonly ids = new Map<string, number>();
  readonly tokens: string[] = [];

  constructor(tokens: readonly string[] = []) {
    for (const t of tokens) this.intern(t);
  }

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

// Contexts above order 1 are keyed by the previous ids packed into one number. Ids stay below
// KEY_BASE, so a triple key stays below 2^51 and is exact in float64.
export const KEY_BASE = 131072;
export const pairKey = (prev2: number, prev1: number): number => prev2 * KEY_BASE + prev1;
export const tripleKey = (prev3: number, prev2: number, prev1: number): number =>
  (prev3 * KEY_BASE + prev2) * KEY_BASE + prev1;

// The context keys for a token given the ids before it, highest order last.
export function chainedKeys(order: number, prev: number[]): number[] {
  const keys = [prev[0]];
  if (order >= 2) keys.push(pairKey(prev[1], prev[0]));
  if (order >= 3) keys.push(tripleKey(prev[2], prev[1], prev[0]));
  return keys;
}

export type Keys = Float64Array | Uint32Array;
export type Ids = Uint16Array | Uint32Array;
export type Counts = Uint16Array | Uint32Array;

// One context order in compressed sparse rows: context keys ascending, and context i's
// successors at [offsets[i], offsets[i + 1]) of sids/counts, ascending by id.
export interface Level {
  keys: Keys;
  offsets: Uint32Array;
  sids: Ids;
  counts: Counts;
}

// Every token seen in a stream with its count, ascending by id.
export interface Unigrams {
  sids: Ids;
  counts: Counts;
}

// Escape weight for a unigram table: hapax count, at least 1.
function hapaxEscape(counts: Counts): number {
  let hapax = 0;
  for (const n of counts) if (n === 1) hapax++;
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

function find(keys: Keys, key: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keys[mid];
    if (k === key) return mid;
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export class Stream {
  readonly escape: number;
  private readonly caches: Map<number, Table>[];
  private readonly sorted: Map<number, [number, number][] | null>[];
  private uniTable: Table | null = null;

  // levels[k] holds the order-(k + 1) contexts.
  constructor(readonly vocab: Vocab, readonly levels: Level[], readonly uni: Unigrams) {
    this.escape = hapaxEscape(uni.counts);
    this.caches = levels.map(() => new Map());
    this.sorted = levels.map(() => new Map());
  }

  get order(): number {
    return this.levels.length;
  }

  // Sorted successors of a context at `level` (0 = order 1), or null when never seen.
  successors(level: number, key: number): [number, number][] | null {
    const cache = this.sorted[level];
    let sorted = cache.get(key);
    if (sorted === undefined) {
      const lv = this.levels[level];
      const i = find(lv.keys, key);
      if (i < 0) {
        sorted = null;
      } else {
        sorted = [];
        for (let j = lv.offsets[i]; j < lv.offsets[i + 1]; j++) sorted.push([lv.sids[j], lv.counts[j]]);
      }
      cache.set(key, sorted);
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
      const items: [number, number][] = [];
      for (let i = 0; i < this.uni.sids.length; i++) items.push([this.uni.sids[i], this.uni.counts[i]]);
      this.uniTable = excludingTable(items, NONE, this.escape)!;
    }
    return this.uniTable;
  }

  // The context to carry forward after emitting `token`.
  contextFor(token: string): number {
    return this.vocab.ids.get(token) ?? UNK;
  }
}

export interface ModelParts {
  wordOrder: number;
  streams: Map<string, Stream>;
  seps: Stream;
  // Word strings interned as separator contexts; shared across sections.
  sepCtx: Vocab;
  // Section kinds in id order, with how often each was seen.
  kinds: string[];
  kindCounts: number[];
  // How often each byte value appeared in the training text.
  byteCounts: number[];
}

export class Model {
  readonly wordOrder: number;
  readonly streams: Map<string, Stream>;
  readonly seps: Stream;
  readonly sepCtx: Vocab;
  readonly kinds: string[];
  readonly kindCounts: number[];
  readonly byteCounts: number[];
  private readonly kindIds: Map<string, number>;
  private byteTbl: Table | null = null;
  private kindTbl: Table | null = null;

  constructor(parts: ModelParts) {
    this.wordOrder = parts.wordOrder;
    this.streams = parts.streams;
    this.seps = parts.seps;
    this.sepCtx = parts.sepCtx;
    this.kinds = parts.kinds;
    this.kindCounts = parts.kindCounts;
    this.byteCounts = parts.byteCounts;
    this.kindIds = new Map(parts.kinds.map((k, i) => [k, i]));
  }

  // The id a section's word contexts start from: a marker for its context, else BOS.
  startContext(stream: Stream, section: Section): number {
    if (section.context === undefined) return BOS;
    return stream.vocab.ids.get(contextMarker(section.context)) ?? UNK;
  }

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

  kindTable(): Table {
    if (!this.kindTbl) this.kindTbl = buildTable(this.kindCounts.map((n, id) => [id, n]));
    return this.kindTbl;
  }

  // Every byte value stays representable even if unseen; literals average about six bytes,
  // which sets the terminator's weight.
  byteTable(): Table {
    if (!this.byteTbl) {
      let total = 0;
      for (const n of this.byteCounts) total += n;
      const items: [number, number][] = [];
      for (let b = 0; b < 256; b++) items.push([b, this.byteCounts[b] + 1]);
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
      s.levels.forEach((lv, level) => {
        contexts[level] = (contexts[level] ?? 0) + lv.keys.length;
        entries[level] = (entries[level] ?? 0) + lv.sids.length;
      });
    }
    return { streams: this.streams.size, wordVocab: vocab, entries, contexts };
  }
}

// The vocabulary entry a section context starts from. Markers are context-only ids, never
// coded as tokens.
export const contextMarker = (context: string): string => `\u0001${context}`;
