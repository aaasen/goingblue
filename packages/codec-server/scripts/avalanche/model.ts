/**
 * Order-1 Markov model over word and separator streams, with PPM-style escapes.
 *
 * Coding a token is a ladder. Each level is a real rANS table, so falling through costs only
 * the bits of the escape symbol:
 *
 *   order-2 table   successors seen in a pair context, plus ESC; skipped without cost when
 *                   the pair was never seen. Words: the previous two words. Separators: the
 *                   words on either side.
 *   context table   successors seen in the order-1 context, plus ESC. Words: the previous
 *                   word. Separators: the word that follows.
 *   unigram table   every token seen in this stream, plus ESC
 *   byte table      UTF-8 bytes of the literal, plus END
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

function unigramTable(counts: Map<number, number>, escape: number): Table {
  const items: [number, number][] = [...counts].sort((a, b) => a[0] - b[0]);
  items.push([ESC, escape]);
  return buildTable(items);
}

// Order-2 contexts are keyed by the pair of previous ids packed into one number; ids stay far
// below 2^20 so the key is exact in float64.
const PAIR_BASE = 1048576;
export const pairKey = (prev2: number, prev1: number): number => prev2 * PAIR_BASE + prev1;

function bump(map: Map<number, Map<number, number>>, c: number, sid: number): void {
  let succ = map.get(c);
  if (!succ) map.set(c, (succ = new Map()));
  succ.set(sid, (succ.get(sid) ?? 0) + 1);
}

export class Stream {
  readonly ctx = new Map<number, Map<number, number>>();
  readonly ctx2 = new Map<number, Map<number, number>>();
  readonly uni = new Map<number, number>();
  escape = 1;
  readonly vocab = new Vocab();
  private cache = new Map<number, Table>();
  private cache2 = new Map<number, Table>();
  private uniTable: Table | null = null;

  // Word streams chain their own contexts; the separator stream is given explicit ones.
  constructor(readonly order: 1 | 2 = 1) {}

  // Counts each token under its contexts: contexts[i] and contexts2[i] when given, else the
  // previous token and the previous pair at order 2.
  observe(seq: string[], contexts?: number[], contexts2?: number[]): void {
    let prev1 = BOS;
    let prev2 = BOS;
    for (let i = 0; i < seq.length; i++) {
      const sid = this.vocab.intern(seq[i]);
      bump(this.ctx, contexts ? contexts[i] : prev1, sid);
      if (contexts2) bump(this.ctx2, contexts2[i], sid);
      else if (this.order === 2) bump(this.ctx2, pairKey(prev2, prev1), sid);
      this.uni.set(sid, (this.uni.get(sid) ?? 0) + 1);
      prev2 = prev1;
      prev1 = sid;
    }
  }

  // Drops context successors seen fewer than minCount times, then fixes the escape weight.
  finalize(minCount = 1): void {
    if (minCount > 1) {
      for (const map of [this.ctx, this.ctx2]) {
        for (const [c, succ] of [...map]) {
          for (const [s, n] of [...succ]) if (n < minCount) succ.delete(s);
          if (succ.size === 0) map.delete(c);
        }
      }
    }
    this.escape = hapaxEscape(this.uni);
    this.cache.clear();
    this.cache2.clear();
    this.uniTable = null;
  }

  // The order-2 table for a pair, or null when the pair was never seen (both sides know, so
  // no escape is coded).
  context2Table(key: number): Table | null {
    const succ = this.ctx2.get(key);
    if (!succ) return null;
    let tbl = this.cache2.get(key);
    if (!tbl) {
      const items: [number, number][] = [...succ].sort((a, b) => a[0] - b[0]);
      items.push([ESC, succ.size]);
      tbl = buildTable(items);
      this.cache2.set(key, tbl);
    }
    return tbl;
  }

  contextTable(ctxId: number): Table {
    let tbl = this.cache.get(ctxId);
    if (!tbl) {
      const succ = this.ctx.get(ctxId);
      const items: [number, number][] = succ ? [...succ].sort((a, b) => a[0] - b[0]) : [];
      items.push([ESC, succ ? succ.size : 1]);
      tbl = buildTable(items);
      this.cache.set(ctxId, tbl);
    }
    return tbl;
  }

  unigramTable(): Table {
    if (!this.uniTable) this.uniTable = unigramTable(this.uni, this.escape);
    return this.uniTable;
  }

  // The context to carry forward after emitting `token`.
  contextFor(token: string): number {
    return this.vocab.ids.get(token) ?? UNK;
  }
}

const utf8 = new TextEncoder();

export class Model {
  readonly streams = new Map<string, Stream>();
  readonly seps = new Stream();
  // Word strings interned as separator contexts; shared across sections.
  readonly sepCtx = new Vocab();
  readonly bytes = new Map<number, number>();
  readonly kinds: string[] = [];
  private readonly kindIds = new Map<string, number>();
  private readonly kindCounts = new Map<number, number>();
  private byteTbl: Table | null = null;
  private kindTbl: Table | null = null;

  // The order-1 context of a separator: the word after it, or END for the trailing one.
  sepContextFor(nextWord: string | null): number {
    return nextWord === null ? END : (this.sepCtx.ids.get(nextWord) ?? UNK);
  }

  // The order-2 context of a separator: the words on either side, BOS before the first word.
  sepContext2For(prevWord: string | null, nextWord: string | null): number {
    return pairKey(prevWord === null ? BOS : (this.sepCtx.ids.get(prevWord) ?? UNK), this.sepContextFor(nextWord));
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
    if (!stream) this.streams.set(section.kind, (stream = new Stream(2)));
    const toks = tokenize(section.text);
    stream.observe(toks.words);
    const ids = toks.words.map((w) => this.sepCtx.intern(w));
    const contexts = [...ids, END];
    const contexts2 = contexts.map((next, i) => pairKey(i === 0 ? BOS : ids[i - 1], next));
    this.seps.observe(toks.seps, contexts, contexts2);
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

  // Rough ship weight: vocabulary, bigram, and trigram entries summed over streams.
  stats(): { streams: number; wordVocab: number; wordContexts: number; wordBigrams: number; wordContexts2: number; wordTrigrams: number } {
    let vocab = 0;
    let contexts = 0;
    let bigrams = 0;
    let contexts2 = 0;
    let trigrams = 0;
    for (const s of this.streams.values()) {
      vocab += s.vocab.size;
      contexts += s.ctx.size;
      for (const succ of s.ctx.values()) bigrams += succ.size;
      contexts2 += s.ctx2.size;
      for (const succ of s.ctx2.values()) trigrams += succ.size;
    }
    return { streams: this.streams.size, wordVocab: vocab, wordContexts: contexts, wordBigrams: bigrams, wordContexts2: contexts2, wordTrigrams: trigrams };
  }
}
