/**
 * An order-1 token stream with escapes, the coder under every structured field.
 *
 * Coding a token is a ladder. Each rung is a real rANS table, so falling through costs only the
 * bits of the escape symbol:
 *
 *   context table   successors seen after this context, plus ESC weighted by their number; a
 *                   context never seen has an escape-only table
 *   unigram table   every token seen in the stream, plus ESC weighted by the hapax count, a
 *                   Good-Turing estimate of the chance the next token is one never seen
 *   byte table      UTF-8 bytes of the literal, plus LIT_END
 *
 * The bottom rung is over bytes, which makes the coder total: any token round-trips.
 *
 * The counts are read-only here, held as sorted typed arrays so a trained model loads without
 * parsing (see pack.ts); training lives in the codec server's scripts. Both sides build tables
 * from the same stored counts in the same sorted order. That determinism, not the counts
 * themselves, is what keeps them in sync.
 */
import { Decoder, buildTable, type Decision, type Table } from "./rans.js";
import { decodeUtf8 } from "./utf8.js";

export const ESC = 0;
export const BOS = 1;
export const UNK = 2;
export const FIRST = 4;
export const LIT_END = 256;

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

export type Ids = Uint16Array | Uint32Array;
export type Counts = Uint16Array | Uint32Array;

// Contexts in compressed sparse rows: context ids ascending, and context i's successors at
// [offsets[i], offsets[i + 1]) of sids/counts, ascending by id.
export interface Contexts {
  keys: Uint32Array;
  offsets: Uint32Array;
  sids: Ids;
  counts: Counts;
}

// Every token seen in a stream with its count, ascending by id.
export interface Unigrams {
  sids: Ids;
  counts: Counts;
}

function find(keys: Uint32Array, key: number): number {
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
  private readonly tables = new Map<number, Table>();
  private uniTable: Table | null = null;

  constructor(readonly vocab: Vocab, readonly contexts: Contexts, readonly uni: Unigrams) {}

  contextTable(key: number): Table {
    let table = this.tables.get(key);
    if (!table) {
      const c = this.contexts;
      const i = find(c.keys, key);
      const items: [number, number][] = [];
      if (i >= 0) for (let j = c.offsets[i]; j < c.offsets[i + 1]; j++) items.push([c.sids[j], c.counts[j]]);
      table = buildTable([...items, [ESC, Math.max(1, items.length)]]);
      this.tables.set(key, table);
    }
    return table;
  }

  unigramTable(): Table {
    if (!this.uniTable) {
      const items: [number, number][] = [];
      let hapax = 0;
      for (let i = 0; i < this.uni.sids.length; i++) {
        items.push([this.uni.sids[i], this.uni.counts[i]]);
        if (this.uni.counts[i] === 1) hapax++;
      }
      this.uniTable = buildTable([...items, [ESC, Math.max(1, hapax)]]);
    }
    return this.uniTable;
  }
}

const utf8 = new TextEncoder();

// Appends the decisions that code `token` after context `key`.
export function planToken(plan: Decision[], stream: Stream, byteTable: Table, key: number, token: string): void {
  const sid = stream.vocab.ids.get(token);
  const context = stream.contextTable(key);
  if (sid !== undefined && context.index.has(sid)) {
    plan.push([context, sid]);
    return;
  }
  plan.push([context, ESC]);
  const uni = stream.unigramTable();
  if (sid !== undefined) {
    plan.push([uni, sid]);
    return;
  }
  plan.push([uni, ESC]);
  for (const b of utf8.encode(token)) plan.push([byteTable, b]);
  plan.push([byteTable, LIT_END]);
}

export function readToken(dec: Decoder, stream: Stream, byteTable: Table, key: number): string {
  let sid = dec.get(stream.contextTable(key));
  if (sid !== ESC) return stream.vocab.token(sid);
  sid = dec.get(stream.unigramTable());
  if (sid !== ESC) return stream.vocab.token(sid);
  const raw: number[] = [];
  for (;;) {
    const b = dec.get(byteTable);
    if (b === LIT_END) break;
    raw.push(b);
  }
  return decodeUtf8(Uint8Array.from(raw));
}
