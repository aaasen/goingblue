/**
 * Lossless word tokenizer. Splits text into two parallel streams: `words`, which the Markov
 * model predicts, and `seps`, the gaps between them, with seps.length === words.length + 1.
 * seps[0] is any leading gap and seps[i + 1] follows words[i], so detokenize() is an exact
 * inverse for any input. Separators are the literal text between matches rather than a pattern
 * of their own, which makes that guarantee structural.
 *
 * Words are runs of letters and digits with internal apostrophes (Tonight's, 70s, 4SM).
 * Everything else, whitespace and punctuation alike, is separator, so ", " and ".\n\n" are
 * separator tokens and the word stream sees only words. Word bigrams then skip over
 * punctuation, and each separator is predicted from the word after it (see codec.ts).
 */

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export interface Tokens {
  words: string[];
  seps: string[];
}

export function tokenize(text: string): Tokens {
  const words: string[] = [];
  const seps: string[] = [];
  let pos = 0;
  for (const m of text.matchAll(WORD_RE)) {
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
