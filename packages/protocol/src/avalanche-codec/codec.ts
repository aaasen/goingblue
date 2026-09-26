/**
 * Encode and decode a bulletin as a list of prose sections.
 *
 * The encoder walks each section's token streams forward and records a plan: the flat list of
 * (table, symbol) decisions the model makes, escapes and literal bytes included. rANS then runs
 * over the plan in reverse because the coder is LIFO. The decoder re-walks the same state
 * machine, and at every step the model tells it which table to read next from what it has
 * already decoded.
 *
 * Layout, with the section count from a varint header and each section as
 *   kind  N  words[0] seps[0] words[1] seps[1] ... words[N-1] seps[N-1] seps[N]
 * where kind is a symbol from the kind table and N is coded as a raw varint in the byte stream
 * ahead of the rANS body. Each separator is coded after the word that follows it in the text,
 * so the decoder has the words on both sides of it as its contexts; the trailing separator's
 * next word is END. Word contexts restart at BOS for every section.
 *
 * A token walks the ladder in model.ts: its stream's context orders from highest to lowest
 * (unseen higher-order contexts are skipped), unigram, then bytes. Each rung is entered by an
 * ESC read from the rung above, and the symbols of every context rung escaped from are
 * excluded from the context rungs below.
 */
import { BOS, ESC, LIT_END, chainedKeys, type Model, type Stream } from "./model.js";
import { Decoder, costBits, encode as ransEncode, type Decision, type Table } from "./rans.js";
import type { Section } from "./model.js";
import { detokenize, tokenize } from "./tokenizer.js";

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// The ladder rung a token was coded on: a context order, the unigram, or a byte literal.
export type Rung = "order3" | "order2" | "context" | "unigram" | "bytes";
const RUNGS: Rung[] = ["context", "order2", "order3"];

function putVarint(out: number[], n: number): void {
  for (;;) {
    const b = n % 128;
    n = Math.floor(n / 128);
    out.push(n ? b + 128 : b);
    if (!n) return;
  }
}

function getVarint(buf: Uint8Array, pos: number): [number, number] {
  let n = 0;
  let mul = 1;
  for (;;) {
    const b = buf[pos++];
    n += (b % 128) * mul;
    if (b < 128) return [n, pos];
    mul *= 128;
  }
}

// keys[k] is the token's context at order k + 1; the ladder runs from the highest order down.
// Returns the id to carry forward and the rung the token was coded on.
export function planToken(plan: Decision[], stream: Stream, byteTable: Table, keys: number[], token: string): [number, Rung] {
  const sid = stream.vocab.ids.get(token);
  const excluded = new Set<number>();
  for (let level = keys.length - 1; level >= 0; level--) {
    const table = stream.contextTable(level, keys[level], excluded);
    if (!table) continue;
    if (sid !== undefined && table.index.has(sid)) {
      plan.push([table, sid]);
      return [sid, RUNGS[level]];
    }
    plan.push([table, ESC]);
    for (const s of table.symbols) excluded.add(s);
  }
  const uni = stream.unigramTable();
  if (sid !== undefined) {
    plan.push([uni, sid]);
    return [sid, "unigram"];
  }
  plan.push([uni, ESC]);
  for (const b of utf8.encode(token)) plan.push([byteTable, b]);
  plan.push([byteTable, LIT_END]);
  return [stream.contextFor(token), "bytes"];
}

export function readToken(dec: Decoder, stream: Stream, byteTable: Table, keys: number[]): [string, number] {
  const excluded = new Set<number>();
  for (let level = keys.length - 1; level >= 0; level--) {
    const table = stream.contextTable(level, keys[level], excluded);
    if (!table) continue;
    const sid = dec.get(table);
    if (sid !== ESC) return [stream.vocab.token(sid), sid];
    for (const s of table.symbols) excluded.add(s);
  }
  const sid = dec.get(stream.unigramTable());
  if (sid !== ESC) return [stream.vocab.token(sid), sid];
  const raw: number[] = [];
  for (;;) {
    const b = dec.get(byteTable);
    if (b === LIT_END) break;
    raw.push(b);
  }
  const token = utf8Decode.decode(Uint8Array.from(raw));
  return [token, stream.contextFor(token)];
}

// Walks one section's tokens in coding order, calling back with each token and its context
// keys. The encoder plans with it and the cost breakdown attributes with it.
function walkSection(
  model: Model, section: Section,
  word: (token: string, keys: number[]) => number,
  sep: (token: string, keys: number[]) => void,
): number {
  const toks = tokenize(section.text);
  const n = toks.words.length;
  const prev = [model.startContext(model.streamFor(section.kind), section), BOS, BOS];
  let prevToken: string | null = null;
  for (let i = 0; i < n; i++) {
    const token = toks.words[i];
    const sid = word(token, chainedKeys(model.wordOrder, prev));
    prev.unshift(sid);
    prev.pop();
    sep(toks.seps[i], model.sepKeys(prevToken, token));
    prevToken = token;
  }
  sep(toks.seps[n], model.sepKeys(prevToken, null));
  return n;
}

// Appends one section's decisions, kind symbol first, and returns its word count.
function planSection(model: Model, out: Decision[], section: Section): number {
  out.push([model.kindTable(), model.kindId(section.kind)]);
  const words = model.streamFor(section.kind);
  const byteTable = model.byteTable();
  return walkSection(
    model, section,
    (token, keys) => planToken(out, words, byteTable, keys, token)[0],
    (token, keys) => planToken(out, model.seps, byteTable, keys, token)[0],
  );
}

// The varint header (section count, then each section's word count) and the decisions for a
// list of sections.
export function planSections(model: Model, sections: Section[]): { header: number[]; plan: Decision[] } {
  const header: number[] = [];
  putVarint(header, sections.length);
  const plan: Decision[] = [];
  for (const s of sections) putVarint(header, planSection(model, plan, s));
  return { header, plan };
}

export function readHeader(blob: Uint8Array): { wordCounts: number[]; pos: number } {
  let [count, pos] = getVarint(blob, 0);
  const wordCounts: number[] = [];
  for (let i = 0; i < count; i++) {
    const [n, p] = getVarint(blob, pos);
    wordCounts.push(n);
    pos = p;
  }
  return { wordCounts, pos };
}

// `contextFor` supplies a section's context from its kind and its index among sections of
// that kind, which the caller knows from the structured fields decoded ahead of the prose.
export function readSections(
  model: Model, dec: Decoder, wordCounts: number[],
  contextFor: (kind: string, index: number) => string | undefined = () => undefined,
): Section[] {
  const byteTable = model.byteTable();
  const out: Section[] = [];
  const seen = new Map<string, number>();
  for (const nWords of wordCounts) {
    const kind = model.kinds[dec.get(model.kindTable())];
    const stream = model.streamFor(kind);
    const index = seen.get(kind) ?? 0;
    seen.set(kind, index + 1);
    const context = contextFor(kind, index);
    const section: Section = context === undefined ? { kind, text: "" } : { kind, text: "", context };
    const words: string[] = [];
    const seps: string[] = [];
    const prev = [model.startContext(stream, section), BOS, BOS];
    let prevToken: string | null = null;
    for (let i = 0; i < nWords; i++) {
      const [word, sid] = readToken(dec, stream, byteTable, chainedKeys(model.wordOrder, prev));
      prev.unshift(sid);
      prev.pop();
      words.push(word);
      seps.push(readToken(dec, model.seps, byteTable, model.sepKeys(prevToken, word))[0]);
      prevToken = word;
    }
    seps.push(readToken(dec, model.seps, byteTable, model.sepKeys(prevToken, null))[0]);
    section.text = detokenize({ words, seps });
    out.push(section);
  }
  return out;
}

export function frame(header: number[], plan: Decision[]): Uint8Array {
  const body = ransEncode(plan);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

export function encode(model: Model, sections: Section[]): Uint8Array {
  const { header, plan } = planSections(model, sections);
  return frame(header, plan);
}

export function decode(
  model: Model, blob: Uint8Array, contextFor?: (kind: string, index: number) => string | undefined,
): Section[] {
  const { wordCounts, pos } = readHeader(blob);
  return readSections(model, new Decoder(blob, pos), wordCounts, contextFor);
}

// What each token of a section cost. Re-walks the real encoder path, so these are the bits the
// coder actually pays. `rung` names the ladder rung the token was coded on.

export interface TokenCost {
  stream: "word" | "sep";
  token: string;
  bits: number;
  rung: Rung;
}

export function tokenCosts(model: Model, section: Section): TokenCost[] {
  const words = model.streamFor(section.kind);
  const byteTable = model.byteTable();
  const rows: TokenCost[] = [];
  const plan: Decision[] = [];
  const costed = (stream: "word" | "sep", target: Stream) => (token: string, keys: number[]): number => {
    const mark = plan.length;
    const [next, rung] = planToken(plan, target, byteTable, keys, token);
    let bits = 0;
    for (let k = mark; k < plan.length; k++) bits += costBits(plan[k][0], plan[k][1]);
    rows.push({ stream, token, bits, rung });
    return next;
  };
  walkSection(model, section, costed("word", words), costed("sep", model.seps));
  return rows;
}

// Exact model cost of one section in bits, kind symbol included, without running the coder.
export function sectionBits(model: Model, section: Section): number {
  const plan: Decision[] = [];
  planSection(model, plan, section);
  let bits = 0;
  for (const [table, sym] of plan) bits += costBits(table, sym);
  return bits;
}
