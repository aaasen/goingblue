/**
 * Lossless word tokenizer. Splits text into two parallel streams: `words`, which the Markov
 * model predicts, and `seps`, the gaps between them, with seps.length === words.length + 1.
 * seps[0] is any leading gap and seps[i + 1] follows words[i], so detokenize() is an exact
 * inverse for any input. Separators are the literal text between matches rather than a pattern
 * of their own, which makes that guarantee structural.
 *
 * Keeping separators out of the word stream is the point: a single stream of word, space,
 * word, space puts a separator in every bigram context, and an order-1 model conditioned on
 * " " is just a unigram model.
 *
 * Word grammar: runs of letters and digits with internal apostrophes stay whole (Tonight's,
 * 70s, 4SM), any other single character is a token on its own except that a run of one
 * repeated punctuation character stays together (... and --).
 */

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|([^\p{L}\p{N}\s])\1*/gu;

export interface Tokens {
  words: string[];
  seps: string[];
}

export function tokenize(text: string): Tokens {
  const words: string[] = [];
  const seps: string[] = [];
  let pos = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    seps.push(text.slice(pos, m.index));
    words.push(m[0]);
    pos = m.index + m[0].length;
  }
  seps.push(text.slice(pos));
  return { words, seps };
}

export function detokenize(t: Tokens): string {
  let out = t.seps[0];
  for (let i = 0; i < t.words.length; i++) out += t.words[i] + t.seps[i + 1];
  return out;
}
