/**
 * The trained avalanche models as one binary file, loaded without parsing the counts.
 *
 * Layout:
 *   "GBAM"               magic
 *   u32 LE               format version
 *   u32 LE               header length in bytes
 *   header               UTF-8 JSON: vocabularies, small tables, and where each array lives
 *   zero padding         to a multiple of 8
 *   arrays               each typed array's bytes, 8-byte aligned, offsets relative to here
 *
 * Each context order is stored as columns that compress well: a context key as its word ids
 * (order k has k columns, oldest word first) and each context's successor count instead of
 * running offsets. Loading rebuilds the keys and offsets in one pass; successor ids and counts
 * are views over the file. The arrays are written in the machine's byte order, so both ends
 * must be little-endian, which every supported platform is.
 */
import { KEY_BASE, Model, Stream, Vocab, type Counts, type Ids, type Level } from "./model.js";
import { FIELDS, StructuredModel, type Field, type FieldName } from "./structured.js";
import type { Models } from "./bulletin.js";
import { decodeUtf8 } from "./utf8.js";

const MAGIC = "GBAM";
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
  wordOrder: number;
  kinds: string[];
  kindCounts: number[];
  byteCounts: number[];
  sepCtx: string[];
  streams: [string, StreamDesc][];
  seps: StreamDesc;
  structured: [FieldName, { contexts: string[]; stream: StreamDesc }][];
}

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

const narrow = (v: ArrayLike<number>): Uint16Array | Uint32Array => {
  for (let i = 0; i < v.length; i++) if (v[i] >= 65536) return Uint32Array.from(v);
  return Uint16Array.from(v);
};

// A level's keys split into one column per word id, oldest first: the base-KEY_BASE digits.
function keyColumns(lv: Level, order: number): (Uint16Array | Uint32Array)[] {
  const cols = Array.from({ length: order }, () => new Array<number>(lv.keys.length));
  for (let i = 0; i < lv.keys.length; i++) {
    let k = lv.keys[i];
    for (let c = order - 1; c >= 0; c--) {
      cols[c][i] = k % KEY_BASE;
      k = Math.floor(k / KEY_BASE);
    }
  }
  return cols.map(narrow);
}

function assertLittleEndian(): void {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("pack: big-endian platforms are not supported");
}

export function packModels({ prose, structured }: Models): Uint8Array {
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
    levels: s.levels.map((lv, level) => ({
      key: keyColumns(lv, level + 1).map(put),
      lengths: put(narrow(Array.from({ length: lv.keys.length }, (_, i) => lv.offsets[i + 1] - lv.offsets[i]))),
      sids: put(lv.sids),
      counts: put(lv.counts),
    })),
  });
  const header: Header = {
    wordOrder: prose.wordOrder,
    kinds: prose.kinds,
    kindCounts: prose.kindCounts,
    byteCounts: prose.byteCounts,
    sepCtx: prose.sepCtx.tokens,
    streams: [...prose.streams].map(([name, s]) => [name, stream(s)]),
    seps: stream(prose.seps),
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

export function loadModels(file: Uint8Array): Models {
  assertLittleEndian();
  // Views need their element alignment; a buffer that starts off an 8-byte boundary is copied.
  const bytes = file.byteOffset % 8 === 0 ? file : file.slice();
  if (decodeUtf8(bytes.subarray(0, 4)) !== MAGIC) throw new Error("pack: not an avalanche model file");
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
    const levels: Level[] = d.levels.map((lv) => {
      const cols = lv.key.map(get);
      const lengths = get(lv.lengths);
      const n = lengths.length;
      const keys = cols.length === 1 ? new Uint32Array(n) : new Float64Array(n);
      const offsets = new Uint32Array(n + 1);
      for (let i = 0; i < n; i++) {
        let k = 0;
        for (const c of cols) k = k * KEY_BASE + c[i];
        keys[i] = k;
        offsets[i + 1] = offsets[i] + lengths[i];
      }
      return { keys, offsets, sids: get(lv.sids) as Ids, counts: get(lv.counts) as Counts };
    });
    return new Stream(new Vocab(d.vocab), levels, { sids: get(d.uni.sids) as Ids, counts: get(d.uni.counts) as Counts });
  };
  const prose = new Model({
    wordOrder: header.wordOrder,
    streams: new Map(header.streams.map(([name, d]) => [name, stream(d)])),
    seps: stream(header.seps),
    sepCtx: new Vocab(header.sepCtx),
    kinds: header.kinds,
    kindCounts: header.kindCounts,
    byteCounts: header.byteCounts,
  });
  const fields = new Map<FieldName, Field>(
    header.structured.map(([name, f]) => [name, { contexts: new Vocab(f.contexts), stream: stream(f.stream) }]),
  );
  return { prose, structured: new StructuredModel(fields) };
}
