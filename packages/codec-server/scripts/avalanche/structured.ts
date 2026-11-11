/**
 * Training for the structured coder (packages/protocol/src/avalanche-codec/structured.ts): one
 * order-1 stream per field, counted under the same walk the codec codes with.
 */
import { BOS, Stream, Vocab, type Counts, type Ids } from "@weather/protocol/avalanche-codec/stream";
import { FIELDS, StructuredModel, walk, type Field, type FieldName, type Structured } from "@weather/protocol/avalanche-codec/structured";

// The narrowest typed arrays that hold the values exactly.
const narrow = (v: number[]): Ids & Counts => (v.every((n) => n < 65536) ? Uint16Array.from(v) : Uint32Array.from(v));

class FieldBuilder {
  // context id -> token id -> count
  readonly successors = new Map<number, Map<number, number>>();
  readonly uni = new Map<number, number>();
  readonly vocab = new Vocab();
  readonly contexts = new Vocab();

  observe(token: string, context: string | null): void {
    const sid = this.vocab.intern(token);
    const key = context === null ? BOS : this.contexts.intern(context);
    let succ = this.successors.get(key);
    if (!succ) this.successors.set(key, (succ = new Map()));
    succ.set(sid, (succ.get(sid) ?? 0) + 1);
    this.uni.set(sid, (this.uni.get(sid) ?? 0) + 1);
  }

  build(): Field {
    const keys: number[] = [];
    const offsets = [0];
    const sids: number[] = [];
    const counts: number[] = [];
    for (const [key, succ] of [...this.successors].sort((a, b) => a[0] - b[0])) {
      keys.push(key);
      for (const [sid, n] of [...succ].sort((a, b) => a[0] - b[0])) {
        sids.push(sid);
        counts.push(n);
      }
      offsets.push(sids.length);
    }
    const uni = [...this.uni].sort((a, b) => a[0] - b[0]);
    const stream = new Stream(
      this.vocab,
      { keys: Uint32Array.from(keys), offsets: Uint32Array.from(offsets), sids: narrow(sids), counts: narrow(counts) },
      { sids: narrow(uni.map(([s]) => s)), counts: narrow(uni.map(([, n]) => n)) },
    );
    return { stream, contexts: this.contexts };
  }
}

export class StructuredBuilder {
  readonly fields = new Map<FieldName, FieldBuilder>(FIELDS.map((f) => [f, new FieldBuilder()]));

  observe(s: Structured): void {
    walk(s, s.issueHour, (field, context, token) => {
      this.fields.get(field)!.observe(token!, context);
      return token!;
    });
  }

  build(): StructuredModel {
    return new StructuredModel(new Map([...this.fields].map(([name, f]) => [name, f.build()])));
  }
}
