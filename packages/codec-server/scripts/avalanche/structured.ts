/**
 * The quantitative side of a bulletin: danger ratings by day and elevation band, the problem
 * list (type, elevations, aspects, likelihood, expected size), and the confidence rating.
 *
 * Each field is a token stream with explicit contexts, coded on the same escape ladder as the
 * prose (context, unigram, bytes), so a value never seen in training still round-trips. The
 * contexts are the correlations that matter: bands step down within a day, days repeat, and a
 * problem's elevations, aspects, likelihood, and size follow from its type.
 *
 * Tokens are the protocol's scale values (avalanche.ts); elevations and aspects are joined in
 * scale order and size is "min-max".
 *
 * Coding order:
 *   day count, then per day: alpine | (day, alpine the day before), treeline | alpine,
 *   below treeline | treeline (the first day's alpine is conditioned on nothing)
 *   confidence
 *   problem count, then per problem: type | previous type, elevations | type,
 *   aspects | type, likelihood | type, size | type
 */
import type { AvalancheForecast } from "@weather/protocol";
import { BOS, Stream, Vocab, UNK } from "./model.ts";
import { planToken, readToken } from "./codec.ts";
import { costBits, type Decision, type Decoder } from "./rans.ts";

export interface Problem {
  type: string;
  elevations: string[];
  aspects: string[];
  likelihood: string;
  size: string;           // "min-max"
}

export interface Structured {
  ratings: { alp: string; tln: string; btl: string }[];   // one entry per day
  confidence: string;
  problems: Problem[];
}

export function structuredOf(f: AvalancheForecast): Structured {
  return {
    ratings: f.danger.map((d) => ({ alp: d.alp, tln: d.tln, btl: d.btl })),
    confidence: f.confidence.rating,
    problems: f.problems.map((p) => ({
      type: p.type,
      elevations: [...p.elevations],
      aspects: [...p.aspects],
      likelihood: p.likelihood,
      size: `${p.size.min}-${p.size.max}`,
    })),
  };
}

// One stream per field; contexts are strings interned per stream.
class Field {
  readonly stream = new Stream(1);
  readonly contexts = new Vocab();

  ctx(context: string | null): number {
    return context === null ? BOS : (this.contexts.ids.get(context) ?? UNK);
  }

  observe(token: string, context: string | null): void {
    this.stream.observe([token], [[context === null ? BOS : this.contexts.intern(context)]]);
  }
}

const FIELDS = ["dayCount", "rating", "confidence", "problemCount", "type", "elevations", "aspects", "likelihood", "size"] as const;
type FieldName = (typeof FIELDS)[number];

// Walks a bulletin's fields in coding order. `emit` codes one token under its context and
// returns the token, which lets the decoder drive the same walk by returning what it read.
function walk(s: Structured | null, emit: (field: FieldName, context: string | null, token: string | null) => string): Structured {
  const out: Structured = { ratings: [], confidence: "", problems: [] };
  const days = Number(emit("dayCount", null, s ? String(s.ratings.length) : null));
  for (let d = 0; d < days; d++) {
    const day = { alp: "", tln: "", btl: "" };
    const prevAlp = d === 0 ? null : `alp|${out.ratings[d - 1].alp}`;
    day.alp = emit("rating", prevAlp, s ? s.ratings[d].alp : null);
    day.tln = emit("rating", `tln|${day.alp}`, s ? s.ratings[d].tln : null);
    day.btl = emit("rating", `btl|${day.tln}`, s ? s.ratings[d].btl : null);
    out.ratings.push(day);
  }
  out.confidence = emit("confidence", null, s ? s.confidence : null);
  const count = Number(emit("problemCount", null, s ? String(s.problems.length) : null));
  let prevType: string | null = null;
  for (let i = 0; i < count; i++) {
    const src = s ? s.problems[i] : null;
    const type = emit("type", prevType, src ? src.type : null);
    const problem: Problem = {
      type,
      elevations: emit("elevations", type, src ? src.elevations.join(",") : null).split(",").filter(Boolean),
      aspects: emit("aspects", type, src ? src.aspects.join(",") : null).split(",").filter(Boolean),
      likelihood: emit("likelihood", type, src ? src.likelihood : null),
      size: emit("size", type, src ? src.size : null),
    };
    out.problems.push(problem);
    prevType = type;
  }
  return out;
}

export class StructuredModel {
  readonly fields = new Map<FieldName, Field>(FIELDS.map((f) => [f, new Field()]));

  field(name: FieldName): Field {
    return this.fields.get(name)!;
  }

  observe(s: Structured): void {
    walk(s, (field, context, token) => {
      this.field(field).observe(token!, context);
      return token!;
    });
  }

  finalize(): void {
    for (const f of this.fields.values()) f.stream.finalize();
  }

  // Appends the decisions for `s` to `plan`. The byte table comes from the prose model so
  // literals share one table.
  plan(plan: Decision[], byteTable: Parameters<typeof planToken>[2], s: Structured): void {
    walk(s, (field, context, token) => {
      const f = this.field(field);
      planToken(plan, f.stream, byteTable, [f.ctx(context)], token!);
      return token!;
    });
  }

  read(dec: Decoder, byteTable: Parameters<typeof readToken>[2]): Structured {
    return walk(null, (field, context) => {
      const f = this.field(field);
      return readToken(dec, f.stream, byteTable, [f.ctx(context)])[0];
    });
  }

  bits(byteTable: Parameters<typeof planToken>[2], s: Structured): number {
    const plan: Decision[] = [];
    this.plan(plan, byteTable, s);
    let bits = 0;
    for (const [table, sym] of plan) bits += costBits(table, sym);
    return bits;
  }
}
