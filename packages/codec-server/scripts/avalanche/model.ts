/**
 * Order-1 Markov model over the two token streams, with PPM-style escapes.
 *
 * Coding a token is a three-level ladder. Each level is a real rANS table, so falling through
 * costs only the bits of the escape symbol:
 *
 *   context table   successors actually seen after this context, plus ESC
 *   unigram table   every symbol in the vocabulary, plus ESC
 *   byte table      UTF-8 bytes of the literal, plus END
 *
 * Escape counts follow PPM method C: a context's escape weight is its number of distinct
 * successors. The unigram escape weight is the hapax count, a Good-Turing estimate of the chance
 * the next token is a word never seen. The bottom rung is over bytes, which makes the codec
 * total: any input round-trips.
 *
 * A Model is a set of word streams keyed by section kind: every kind gets its own vocabulary
 * and contexts. Separators and the byte literal table are shared, and a kind table codes which
 * section comes next.
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
const FIRST = 3;
export const LIT_END = 256;

export class Stream {
  ids = new Map<string, number>();
  tokens: string[] = [];
  ctx = new Map<number, Map<number, number>>();
  uni = new Map<number, number>();
  escape = 1;
  private cache = new Map<number, Table>();
  private uniTable: Table | null = null;

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

  observe(seq: string[]): void {
    let prev = BOS;
    for (const tok of seq) {
      const sid = this.intern(tok);
      let succ = this.ctx.get(prev);
      if (!succ) this.ctx.set(prev, (succ = new Map()));
      succ.set(sid, (succ.get(sid) ?? 0) + 1);
      this.uni.set(sid, (this.uni.get(sid) ?? 0) + 1);
      prev = sid;
    }
  }

  // Drops context successors seen fewer than minCount times, then fixes the escape weight.
  finalize(minCount = 1): void {
    if (minCount > 1) {
      for (const [c, succ] of [...this.ctx]) {
        for (const [s, n] of [...succ]) if (n < minCount) succ.delete(s);
        if (succ.size === 0) this.ctx.delete(c);
      }
    }
    let hapax = 0;
    for (const n of this.uni.values()) if (n === 1) hapax++;
    this.escape = Math.max(1, hapax);
    this.cache.clear();
    this.uniTable = null;
  }

  contextTable(ctxId: number): Table {
    let tbl = this.cache.get(ctxId);
    if (!tbl) {
      const succ = this.ctx.get(ctxId);
      const items: [number, number][] = succ
        ? [...succ].sort((a, b) => a[0] - b[0])
        : [];
      items.push([ESC, succ ? succ.size : 1]);
      tbl = buildTable(items);
      this.cache.set(ctxId, tbl);
    }
    return tbl;
  }

  unigramTable(): Table {
    if (!this.uniTable) {
      const items: [number, number][] = [...this.uni].sort((a, b) => a[0] - b[0]);
      items.push([ESC, this.escape]);
      this.uniTable = buildTable(items);
    }
    return this.uniTable;
  }

  contextFor(token: string): number {
    return this.ids.get(token) ?? UNK;
  }
}

const utf8 = new TextEncoder();
export class Model {
  readonly streams = new Map<string, Stream>();
  readonly seps = new Stream();
  readonly bytes = new Map<number, number>();
  readonly kinds: string[] = [];
  private readonly kindIds = new Map<string, number>();
  private readonly kindCounts = new Map<number, number>();
  private byteTbl: Table | null = null;
  private kindTbl: Table | null = null;

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
    if (!stream) this.streams.set(section.kind, (stream = new Stream()));
    const toks = tokenize(section.text);
    stream.observe(toks.words);
    this.seps.observe(toks.seps);
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

  // Rough ship weight: vocabulary entries and distinct bigram entries summed over streams.
  stats(): { streams: number; wordVocab: number; wordContexts: number; wordBigrams: number } {
    let vocab = 0;
    let contexts = 0;
    let bigrams = 0;
    for (const s of this.streams.values()) {
      vocab += s.tokens.length;
      contexts += s.ctx.size;
      for (const succ of s.ctx.values()) bigrams += succ.size;
    }
    return { streams: this.streams.size, wordVocab: vocab, wordContexts: contexts, wordBigrams: bigrams };
  }
}
