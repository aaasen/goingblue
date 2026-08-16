// Splitting one encoded reply across several messages, and putting it back together.
//
// This exists for the iPhone satellite route. A bubble there holds ~140 bytes (see devices.ts),
// which is one useful-but-thin forecast; a reader who wants more has to receive more than one
// message. The relay will happily split a long reply itself, but only to a point: past 70 code
// units the reply leaves as two SMS segments, each re-framed independently, and the bubbles stop
// lining up with anything the reader can reason about. Sending N separate messages, each sized to
// land in exactly one bubble, is both bigger and easier to explain.
//
// Every part is labelled "i/N " and repeats the message header, so the reader can paste them in
// any order and a part from a different forecast is rejected rather than silently decoded. That
// labelling also disposes of the one thing the field probes never confirmed — whether separately
// queued messages arrive in order — because reassembly sorts by index and never trusts arrival
// order.

// "i/N " — the two digits, the slash, and the space that separates the label from the payload.
export const PART_LABEL_CHARS = 4;

// A whole token that is exactly "i/N". Matched against whitespace-delimited tokens rather than
// searched for, so a payload can never be mistaken for a label.
const PART_LABEL = /^(\d+)\/(\d+)$/;

export function partLabel(index: number, total: number): string {
  return `${index}/${total} `;
}

// Splits an encoded reply into labelled parts of at most `bodyCharsPerPart` body characters each.
// A reply that fits in one part is returned as-is, UNLABELLED: the single-message case is the
// common one and must stay byte-identical to what a client without any of this would receive.
export function splitReply(encoded: string, headerChars: number, bodyCharsPerPart: number): string[] {
  const header = encoded.slice(0, headerChars);
  const body = encoded.slice(headerChars);
  if (body.length <= bodyCharsPerPart) return [encoded];

  const bodies: string[] = [];
  for (let i = 0; i < body.length; i += bodyCharsPerPart) {
    bodies.push(body.slice(i, i + bodyCharsPerPart));
  }
  return bodies.map((b, i) => partLabel(i + 1, bodies.length) + header + b);
}

// Rebuilds the encoded reply from pasted text, which may hold one part, several, or an unlabelled
// single message. Whitespace is not significant anywhere: parts may be pasted on separate lines,
// run together on one, or in any order.
//
// `headerCharsOf` reads the repeated header's width off the first part, which carries the version
// tag — the width is version-specific, and reassembly happens before anything is decoded. It is
// never called for an unlabelled reply, since there is no repeated header to strip.
//
// Throws with a reader-facing message when parts are missing or don't belong together — those are
// both things a person can fix by going back to their messages, so they must not surface as a
// generic decode failure.
export function reassembleReply(pasted: string, headerCharsOf: (firstPart: string) => number): string {
  const tokens = pasted.trim().split(/\s+/).filter(Boolean);

  // Collect labelled runs: each label opens a part, and every token after it is that part's
  // payload until the next label.
  const parts = new Map<number, string>();
  let total = 0;
  let current: number | null = null;
  const unlabelled: string[] = [];

  for (const token of tokens) {
    const label = token.match(PART_LABEL);
    if (label) {
      const [index, n] = [Number(label[1]), Number(label[2])];
      if (total && n !== total)
        throw new Error(`These messages are from different forecasts: one says ${total} parts, another says ${n}.`);
      if (parts.has(index)) throw new Error(`Message ${index} of ${n} was pasted twice.`);
      total = n;
      current = index;
      parts.set(index, "");
      continue;
    }
    if (current === null) unlabelled.push(token);
    else parts.set(current, parts.get(current)! + token);
  }

  // No labels at all: a single-message reply, which is every route but a multi-message iPhone one.
  if (total === 0) return unlabelled.join("");
  if (unlabelled.length)
    throw new Error(`Some of the pasted text isn't part of a numbered message — paste each message on its own.`);

  const missing = [];
  for (let i = 1; i <= total; i++) if (!parts.has(i)) missing.push(i);
  if (missing.length) {
    const list = missing.join(", ");
    throw new Error(
      missing.length === 1
        ? `Missing message ${list} of ${total} — paste it too.`
        : `Missing messages ${list} of ${total} — paste them too.`);
  }

  // Every part repeats the header, which is what makes a mismatched pair detectable: same code,
  // same seq, same codebook class, or they aren't the same forecast.
  const headerChars = headerCharsOf(parts.get(1)!);
  const header = parts.get(1)!.slice(0, headerChars);
  let out = parts.get(1)!;
  for (let i = 2; i <= total; i++) {
    const part = parts.get(i)!;
    if (part.slice(0, headerChars) !== header)
      throw new Error(`Message ${i} of ${total} belongs to a different forecast.`);
    out += part.slice(headerChars);
  }
  return out;
}
