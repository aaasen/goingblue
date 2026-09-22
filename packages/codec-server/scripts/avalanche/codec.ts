/**
 * Encode and decode bulletin prose.
 *
 * The encoder walks the token streams forward and records a plan: the flat list of
 * (table, symbol) decisions the model makes, escapes and literal bytes included. rANS then runs
 * over the plan in reverse because the coder is LIFO. The decoder re-walks the same state
 * machine, and at every step the model tells it which table to read next from what it has
 * already decoded.
 *
 * Stream layout, with N from a varint header:
 *   seps[0] words[0] seps[1] words[1] ... words[N-1] seps[N]
 */
import { BOS, ESC, LIT_END, type Model, type Stream } from "./model.ts";
import { Decoder, costBits, encode as ransEncode, type Decision, type Table } from "./rans.ts";
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

function planToken(plan: Decision[], stream: Stream, byteTable: Table, ctx: number, token: string): number {
  const table = stream.contextTable(ctx);
  const sid = stream.ids.get(token);
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

function readToken(dec: Decoder, stream: Stream, byteTable: Table, ctx: number): [string, number] {
  let sid = dec.get(stream.contextTable(ctx));
  if (sid !== ESC) return [stream.token(sid), sid];
  sid = dec.get(stream.unigramTable());
  if (sid !== ESC) return [stream.token(sid), sid];
  const raw: number[] = [];
  for (;;) {
    const b = dec.get(byteTable);
    if (b === LIT_END) break;
    raw.push(b);
  }
  const token = utf8Decode.decode(Uint8Array.from(raw));
  return [token, stream.contextFor(token)];
}

function plan(model: Model, text: string): Decision[] {
  const toks = tokenize(text);
  const byteTable = model.byteTable();
  const out: Decision[] = [];
  let ctxW = BOS;
  let ctxS = BOS;
  for (let i = 0; i <= toks.words.length; i++) {
    ctxS = planToken(out, model.seps, byteTable, ctxS, toks.seps[i]);
    if (i < toks.words.length) ctxW = planToken(out, model.words, byteTable, ctxW, toks.words[i]);
  }
  return out;
}

export function encode(model: Model, text: string): Uint8Array {
  const nWords = tokenize(text).words.length;
  const header: number[] = [];
  putVarint(header, nWords);
  const body = ransEncode(plan(model, text));
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

export function decode(model: Model, blob: Uint8Array): string {
  const [nWords, pos] = getVarint(blob, 0);
  const byteTable = model.byteTable();
  const dec = new Decoder(blob, pos);
  const words: string[] = [];
  const seps: string[] = [];
  let ctxW = BOS;
  let ctxS = BOS;
  for (let i = 0; i <= nWords; i++) {
    const [sep, cs] = readToken(dec, model.seps, byteTable, ctxS);
    seps.push(sep);
    ctxS = cs;
    if (i < nWords) {
      const [word, cw] = readToken(dec, model.words, byteTable, ctxW);
      words.push(word);
      ctxW = cw;
    }
  }
  return detokenize({ words, seps });
}

// Exact model cost of the text in bits, without running the coder.
export function modelBits(model: Model, text: string): number {
  let bits = 0;
  for (const [table, sym] of plan(model, text)) bits += costBits(table, sym);
  return bits;
}
