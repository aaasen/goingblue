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
//
// A reply can also arrive in pieces the server never made: a pipe that splits messages differently
// than we measured, or a request that didn't say which device it would be read on, leaves the
// reader holding numbered nothing — no index, no total, no repeated header. mergeChunks collects
// those too, on the reader's terms: they paste in order, starting with the message that carries
// the header, and the reply is finished when it decodes. It is the recovery path for our model of
// a transport being wrong, so it assumes nothing about how that transport splits.

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

export interface PastedParts {
  // Parts claimed by the labels, keyed by index. A repeated index keeps the LAST payload, so a
  // part pasted twice replaces itself rather than doubling.
  parts: Map<number, string>;
  // How many parts the labels say there are; 0 when the text carries no labels at all.
  total: number;
  // Tokens that appeared before any label.
  unlabelled: string[];
  // A second, different part count, or null. Two labels disagreeing means two forecasts.
  disagreedTotal: number | null;
  // An index that appeared more than once, or null.
  duplicated: number | null;
}

// Reads pasted text into its parts WITHOUT judging it. Nothing here throws: the same text is
// an error when it's the whole of what a reader pasted (reassembleReply) and perfectly ordinary
// when it's one message of several still arriving (mergeParts), so the two decisions live with
// their callers rather than here.
export function readParts(pasted: string): PastedParts {
  const parts = new Map<number, string>();
  const unlabelled: string[] = [];
  let total = 0;
  let disagreedTotal: number | null = null;
  let duplicated: number | null = null;
  let current: number | null = null;

  for (const token of pasted.trim().split(/\s+/).filter(Boolean)) {
    const label = token.match(PART_LABEL);
    if (label) {
      const [index, n] = [Number(label[1]), Number(label[2])];
      if (total && n !== total) disagreedTotal ??= n;
      if (parts.has(index)) duplicated ??= index;
      total ||= n;
      current = index;
      parts.set(index, "");
      continue;
    }
    if (current === null) unlabelled.push(token);
    else parts.set(current, parts.get(current)! + token);
  }
  return { parts, total, unlabelled, disagreedTotal, duplicated };
}

// What a caller must be able to answer about a reply for the merge rules below. Injected rather
// than imported: reassembly runs BEFORE anything is decoded, and this file stays decode-free so
// it can put a message back together without knowing how to read one.
export interface ReplyOracles {
  // The repeated header's width, read off a part's version tag.
  headerCharsOf: (part: string) => number;
  // Whether text decodes on its own as a complete reply.
  decodes: (reply: string) => boolean;
  // Whether text BEGINS a reply this reader asked for — a well-formed message header, for a
  // request they still hold. Only the first message of a transport-split reply has one.
  isHead: (chunk: string) => boolean;
}

// Folds a freshly pasted message into what the reader has already pasted, so the parts of one
// reply can be collected a message at a time instead of all at once. Returns the text to keep.
//
// Anything that isn't demonstrably another part of the SAME reply replaces what came before: a
// whole single-message reply, a part of a different forecast, a different part count, or text
// that isn't a numbered message at all. Appending is the special case, not the default — a
// reader pasting an unrelated forecast must not have it silently welded onto the last one.
export function mergeParts(existing: string, incoming: string, oracles: ReplyOracles): string {
  const { headerCharsOf } = oracles;
  const inc = readParts(incoming);
  const cur = readParts(existing);
  const usable = (p: PastedParts) =>
    p.total > 0 && p.disagreedTotal === null && !p.unlabelled.length && p.parts.size > 0;

  // A part of a reply that is already held WHOLE: the reader went back to their messages and
  // pasted a bubble again, having already collected the reply (or loaded it from somewhere that
  // stores it reassembled and unlabelled, as a saved forecast is). Without this the part would
  // count as unrelated text and REPLACE the complete forecast with one segment of it.
  const held = cur.total === 0 ? cur.unlabelled.join("") : "";
  if (usable(inc) && held && heldWhole(held, inc, headerCharsOf)) return existing;

  // Nothing on either side carries a label: whatever broke this reply up, it wasn't the server.
  if (inc.total === 0 && cur.total === 0) return mergeChunks(existing, incoming, oracles);

  if (!usable(inc) || !usable(cur) || cur.total !== inc.total) return incoming;

  // Every part repeats the header, so comparing it is what tells "the rest of this reply" from
  // "a different reply that also happens to come in two messages".
  const first = (p: PastedParts) => p.parts.get(Math.min(...p.parts.keys()))!;
  const headerChars = headerCharsOf(first(cur));
  if (first(cur).slice(0, headerChars) !== first(inc).slice(0, headerChars)) return incoming;

  const merged = new Map(cur.parts);
  for (const [index, payload] of inc.parts) merged.set(index, payload);
  return [...merged.keys()]
    .sort((a, b) => a - b)
    .map((index) => partLabel(index, inc.total) + merged.get(index)!)
    .join("\n");
}

// The messages a collection is holding, in the order they were pasted. They are joined with
// newlines rather than run together — whitespace is insignificant to reassembly either way, so
// this costs nothing and keeps the boundaries, which is what lets a reader be told how many
// messages they have and lets one pasted twice be recognized exactly rather than guessed at.
export function chunkLines(collected: string): string[] {
  return collected.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Whether text is a reply being collected a message at a time with NO labels to go on: it begins
// with a header, so it is the front of a reply this reader asked for, and it doesn't decode, so
// it isn't all there yet. Both halves are load-bearing — without the header test every unreadable
// paste would look like a reply in progress, and without the decode test a finished one would.
export function collectingChunks(collected: string, oracles: ReplyOracles): boolean {
  const lines = chunkLines(collected);
  return lines.length > 0 && oracles.isHead(lines[0]) && !oracles.decodes(collected);
}

// Folds a pasted message into a reply the TRANSPORT broke up, rather than the server: no labels,
// no repeated header, nothing in the text saying which message this is or how many there are.
//
// So order is the reader's, not ours: messages append in the order they are pasted, and the only
// test for a finished reply is that it decodes. Nothing here counts characters or assumes where a
// pipe splits — this path exists precisely for the case where what we believe about the chunking
// is wrong, so believing anything about it would defeat the purpose.
function mergeChunks(existing: string, incoming: string, oracles: ReplyOracles): string {
  const chunk = incoming.trim();

  // A message of a reply that is already held WHOLE: the reader pasted a bubble again after
  // collecting all of them, or after loading the forecast back from the cache, which stores it
  // reassembled. The messages are consecutive slices of one reply, so one that is already in it
  // appears verbatim — and without this the paste would count as unrelated text and drop a
  // complete forecast back to a single piece of itself (the same trap heldWhole covers for
  // labelled parts).
  if (oracles.decodes(existing) && chunkLines(existing).join("").includes(chunk)) return existing;

  // A reply that stands on its own is the whole of one, however many messages it arrived in.
  if (oracles.decodes(incoming)) return incoming;
  if (!collectingChunks(existing, oracles)) return incoming;

  const lines = chunkLines(existing);
  // Pasted again — the same message, wherever it sits in what's held. Idempotent rather than
  // doubled: appending a second copy would break a collection that was until then fine.
  if (lines.includes(chunk)) return existing;
  // The first message of a different reply. Only the first message ever carries a header, so this
  // starts a collection rather than joining one.
  //
  // isHead is the strict test — a header for a request the reader still holds — and it is the
  // right one HERE too, not just for opening a collection. A weaker "does this look like a
  // header" would reset a collection every time a later message happened to begin with a byte
  // that reads as a version tag, which is about one message in eighty-five, and would do it the
  // same way every time: that reply could never be collected at all. Welding on a message meant
  // for someone else costs a Clear and a retry. Breaking a reply that would otherwise work costs
  // the forecast.
  if (oracles.isHead(chunk)) return chunk;

  return [...lines, chunk].join("\n");
}

// Whether an unlabelled reply already contains every part of an incoming paste. Parts are
// consecutive slices of one body and each repeats the header, so a part that is already in the
// whole appears in it verbatim — matching the header rules out a same-shaped part of some other
// forecast, and no payload wide enough to be a part collides by accident.
function heldWhole(
  held: string, inc: PastedParts, headerCharsOf: (part: string) => number,
): boolean {
  const headerChars = headerCharsOf(held);
  const header = held.slice(0, headerChars);
  const body = held.slice(headerChars);
  return [...inc.parts.values()].every(
    (part) => part.slice(0, headerChars) === header && body.includes(part.slice(headerChars)));
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
  const { total, parts, unlabelled, disagreedTotal, duplicated } = readParts(pasted);

  // No labels at all: a single-message reply, which is every route but a multi-message iPhone one.
  if (total === 0) return unlabelled.join("");

  if (disagreedTotal !== null)
    throw new Error(`These messages are from different forecasts: one says ${total} parts, another says ${disagreedTotal}.`);
  if (duplicated !== null) throw new Error(`Message ${duplicated} of ${total} was pasted twice.`);
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
