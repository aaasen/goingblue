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
 * so the decoder has that word as the separator's context; the trailing separator's context
 * is END. Word contexts restart at BOS for every section.
 *
 * A token walks the ladder in model.ts: order-2 context (words only, when the pair was seen),
 * context, unigram, then bytes. Each rung is entered by an ESC read from the rung above.
 */
import { BOS, ESC, LIT_END, pairKey, type Model, type Stream } from "./model.ts";
import { Decoder, costBits, encode as ransEncode, type Decision, type Table } from "./rans.ts";
import type { Section } from "./text.ts";
import { detokenize, tokenize } from "./tokenizer.ts";

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

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

function planToken(
  plan: Decision[], stream: Stream, byteTable: Table, ctx: number, token: string, ctx2: number | null = null,
): number {
  const sid = stream.vocab.ids.get(token);
  const table2 = ctx2 === null ? null : stream.context2Table(ctx2);
  if (table2) {
    if (sid !== undefined && table2.index.has(sid)) {
      plan.push([table2, sid]);
      return sid;
    }
    plan.push([table2, ESC]);
  }
  const table = stream.contextTable(ctx);
  if (sid !== undefined && table.index.has(sid)) {
    plan.push([table, sid]);
    return sid;
  }
  plan.push([table, ESC]);
  const uni = stream.unigramTable();
  if (sid !== undefined) {
    plan.push([uni, sid]);
    return sid;
  }
  plan.push([uni, ESC]);
  for (const b of utf8.encode(token)) plan.push([byteTable, b]);
  plan.push([byteTable, LIT_END]);
  return stream.contextFor(token);
}

function readToken(
  dec: Decoder, stream: Stream, byteTable: Table, ctx: number, ctx2: number | null = null,
): [string, number] {
  const table2 = ctx2 === null ? null : stream.context2Table(ctx2);
  let sid = table2 ? dec.get(table2) : ESC;
  if (sid !== ESC) return [stream.vocab.token(sid), sid];
  sid = dec.get(stream.contextTable(ctx));
  if (sid !== ESC) return [stream.vocab.token(sid), sid];
  sid = dec.get(stream.unigramTable());
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

// Walks one section's tokens in coding order, calling back with the token and context of each.
// The encoder plans with it and the cost breakdown attributes with it.
function walkSection(
  model: Model, section: Section,
  word: (token: string, ctx: number, ctx2: number) => number,
  sep: (token: string, ctx: number) => number,
): number {
  const toks = tokenize(section.text);
  const n = toks.words.length;
  let ctxW = BOS;
  let prevW = BOS;
  for (let i = 0; i < n; i++) {
    const token = toks.words[i];
    const next = word(token, ctxW, pairKey(prevW, ctxW));
    prevW = ctxW;
    ctxW = next;
    sep(toks.seps[i], model.sepContextFor(token));
  }
  sep(toks.seps[n], model.sepContextFor(null));
  return n;
}

// Appends one section's decisions, kind symbol first, and returns its word count.
function planSection(model: Model, out: Decision[], section: Section): number {
  out.push([model.kindTable(), model.kindId(section.kind)]);
  const words = model.streamFor(section.kind);
  const byteTable = model.byteTable();
  return walkSection(
    model, section,
    (token, ctx, ctx2) => planToken(out, words, byteTable, ctx, token, ctx2),
    (token, ctx) => planToken(out, model.seps, byteTable, ctx, token),
  );
}

export function encode(model: Model, sections: Section[]): Uint8Array {
  const header: number[] = [];
  putVarint(header, sections.length);
  const plan: Decision[] = [];
  for (const s of sections) putVarint(header, planSection(model, plan, s));
  const body = ransEncode(plan);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

export function decode(model: Model, blob: Uint8Array): Section[] {
  let [count, pos] = getVarint(blob, 0);
  const wordCounts: number[] = [];
  for (let i = 0; i < count; i++) {
    const [n, p] = getVarint(blob, pos);
    wordCounts.push(n);
    pos = p;
  }
  const byteTable = model.byteTable();
  const dec = new Decoder(blob, pos);
  const out: Section[] = [];
  for (const nWords of wordCounts) {
    const kind = model.kinds[dec.get(model.kindTable())];
    const stream = model.streamFor(kind);
    const words: string[] = [];
    const seps: string[] = [];
    let ctxW = BOS;
    let prevW = BOS;
    for (let i = 0; i < nWords; i++) {
      const [word, cw] = readToken(dec, stream, byteTable, ctxW, pairKey(prevW, ctxW));
      prevW = ctxW;
      ctxW = cw;
      words.push(word);
      seps.push(readToken(dec, model.seps, byteTable, model.sepContextFor(word))[0]);
    }
    seps.push(readToken(dec, model.seps, byteTable, model.sepContextFor(null))[0]);
    out.push({ kind, text: detokenize({ words, seps }) });
  }
  return out;
}

// What each token of a section cost. Re-walks the real encoder path, so these are the bits the
// coder actually pays. `rung` names the ladder rung the token was coded on.
export type Rung = "order2" | "context" | "unigram" | "bytes";

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
  const costed = (stream: "word" | "sep", target: Stream) => (token: string, ctx: number, ctx2: number | null = null): number => {
    const mark = plan.length;
    const next = planToken(plan, target, byteTable, ctx, token, ctx2);
    let bits = 0;
    let escapes = 0;
    for (let k = mark; k < plan.length; k++) {
      bits += costBits(plan[k][0], plan[k][1]);
      if (plan[k][1] === ESC && plan[k][0] !== byteTable) escapes++;
    }
    const had2 = ctx2 !== null && target.context2Table(ctx2) !== null;
    const depth = escapes - (had2 ? 1 : 0);
    const rung: Rung = had2 && escapes === 0 ? "order2" : depth <= 0 ? "context" : depth === 1 ? "unigram" : "bytes";
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
