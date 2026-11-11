/**
 * A center's trained structured model (structured.ts) as one binary file, loaded without parsing
 * the counts.
 *
 * Layout:
 *   "GBAM"               magic
 *   u32 LE               format version
 *   u32 LE               header length in bytes
 *   header               UTF-8 JSON: vocabularies, small tables, and where each array lives
 *   zero padding         to a multiple of 8
 *   arrays               each typed array's bytes, 8-byte aligned, offsets relative to here
 *
 * A stream's contexts are stored as one level of columns that compress well: the context ids
 * and each context's successor count instead of running offsets. Loading rebuilds the offsets
 * in one pass; context ids, successor ids, and counts are views over the file. The arrays are
 * written in the machine's byte order, so both ends must be little-endian, which every
 * supported platform is.
 */
import { Stream, Vocab, type Counts, type Ids } from "./stream.js";
import { FIELDS, StructuredModel, type Field, type FieldName } from "./structured.js";
import { decodeUtf8 } from "./utf8.js";

const MAGIC = "GBAS";
const FORMAT_VERSION = 1;

type ArrayType = "u16" | "u32" | "f64";
// [type, byte offset from the start of the arrays, element count]
type Ref = [ArrayType, number, number];

interface StreamDesc {
  vocab: string[];
  uni: { sids: Ref; counts: Ref };
  levels: { key: Ref[]; lengths: Ref; sids: Ref; counts: Ref }[];
}

interface Header {
  structured: [FieldName, { contexts: string[]; stream: StreamDesc }][];
}

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

const narrow = (v: ArrayLike<number>): Uint16Array | Uint32Array => {
  for (let i = 0; i < v.length; i++) if (v[i] >= 65536) return Uint32Array.from(v);
  return Uint16Array.from(v);
};

function assertLittleEndian(): void {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("pack: big-endian platforms are not supported");
}

export function packStructured(structured: StructuredModel): Uint8Array {
  assertLittleEndian();
  const arrays: [ArrayBufferView, number][] = [];
  let size = 0;
  const put = (a: Uint16Array | Uint32Array | Float64Array): Ref => {
    const ref: Ref = [a instanceof Float64Array ? "f64" : a instanceof Uint32Array ? "u32" : "u16", size, a.length];
    arrays.push([a, size]);
    size = align8(size + a.byteLength);
    return ref;
  };
  const stream = (s: Stream): StreamDesc => ({
    vocab: s.vocab.tokens,
    uni: { sids: put(s.uni.sids), counts: put(s.uni.counts) },
    levels: [{
      key: [put(narrow(s.contexts.keys))],
      lengths: put(narrow(Array.from({ length: s.contexts.keys.length }, (_, i) => s.contexts.offsets[i + 1] - s.contexts.offsets[i]))),
      sids: put(s.contexts.sids),
      counts: put(s.contexts.counts),
    }],
  });
  const header: Header = {
    structured: FIELDS.map((name) => {
      const f = structured.field(name);
      return [name, { contexts: f.contexts.tokens, stream: stream(f.stream) }];
    }),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = align8(12 + json.length);
  const out = new Uint8Array(start + size);
  out.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, json.length, true);
  out.set(json, 12);
  for (const [a, offset] of arrays) out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), start + offset);
  return out;
}

export function loadStructured(file: Uint8Array): StructuredModel {
  assertLittleEndian();
  // Views need their element alignment; a buffer that starts off an 8-byte boundary is copied.
  const bytes = file.byteOffset % 8 === 0 ? file : file.slice();
  if (decodeUtf8(bytes.subarray(0, 4)) !== MAGIC) throw new Error("pack: not an avalanche structured model file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) throw new Error(`pack: unsupported format version ${version}`);
  const length = view.getUint32(8, true);
  const header = JSON.parse(decodeUtf8(bytes.subarray(12, 12 + length))) as Header;
  const start = bytes.byteOffset + align8(12 + length);
  const get = ([type, offset, n]: Ref): Uint16Array | Uint32Array | Float64Array => {
    const at = start + offset;
    if (type === "f64") return new Float64Array(bytes.buffer, at, n);
    if (type === "u32") return new Uint32Array(bytes.buffer, at, n);
    return new Uint16Array(bytes.buffer, at, n);
  };
  const stream = (d: StreamDesc): Stream => {
    if (d.levels.length !== 1 || d.levels[0].key.length !== 1) throw new Error("pack: a stream must have one order-1 level");
    const lv = d.levels[0];
    const lengths = get(lv.lengths);
    const offsets = new Uint32Array(lengths.length + 1);
    for (let i = 0; i < lengths.length; i++) offsets[i + 1] = offsets[i] + lengths[i];
    const contexts = { keys: Uint32Array.from(get(lv.key[0])), offsets, sids: get(lv.sids) as Ids, counts: get(lv.counts) as Counts };
    return new Stream(new Vocab(d.vocab), contexts, { sids: get(d.uni.sids) as Ids, counts: get(d.uni.counts) as Counts });
  };
  const fields = new Map<FieldName, Field>(
    header.structured.map(([name, f]) => [name, { contexts: new Vocab(f.contexts), stream: stream(f.stream) }]),
  );
  return new StructuredModel(fields);
}
