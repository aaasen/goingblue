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
 *   validity (minutes from the issue time, as the wire carries it, to the expiry)
 *   day count, then per day: date, alpine | (day, alpine the day before), treeline | alpine,
 *   below treeline | treeline (the first day's alpine is conditioned on nothing)
 *   The first day's date is days from the issue time's UTC date, conditioned on the issue's UTC
 *   hour; each later day's is days from the day before.
 *   confidence
 *   problem count, then per problem: type | previous type, elevations | type,
 *   aspects | type, likelihood | type, size | type
 */
import type { AvalancheForecast } from "../avalanche.js";
import { daysBetween, quantizeIssued, utcDate } from "./time.js";
import { BOS, UNK, type Stream, type Vocab } from "./model.js";
import { planToken, readToken } from "./codec.js";
import { costBits, type Decision, type Decoder, type Table } from "./rans.js";

export interface Problem {
  type: string;
  elevations: string[];
  aspects: string[];
  likelihood: string;
  size: string;           // "min-max"
}

export interface Structured {
  issueHour: number;      // UTC hour of the issue time; context only, the wire header carries it
  validity: string;       // minutes, or "" when the bulletin has no expiry
  ratings: { date: string; alp: string; tln: string; btl: string }[];   // one entry per day; date as coded
  confidence: string;
  problems: Problem[];
}

export function structuredOf(f: AvalancheForecast): Structured {
  const issued = quantizeIssued(f.issued);
  return {
    issueHour: new Date(issued).getUTCHours(),
    validity: Number.isFinite(f.expires) ? String(Math.round((f.expires - issued) / 60000)) : "",
    ratings: f.danger.map((d, i) => ({
      date: String(daysBetween(i === 0 ? utcDate(issued) : f.danger[i - 1].date, d.date)),
      alp: d.alp, tln: d.tln, btl: d.btl,
    })),
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

export const FIELDS = ["validity", "dayCount", "date", "rating", "confidence", "problemCount", "type", "elevations", "aspects", "likelihood", "size"] as const;
export type FieldName = (typeof FIELDS)[number];

// One order-1 stream per field; contexts are strings interned per field.
export interface Field {
  stream: Stream;
  contexts: Vocab;
}

const ctx = (f: Field, context: string | null): number =>
  context === null ? BOS : (f.contexts.ids.get(context) ?? UNK);

// Walks a bulletin's fields in coding order. `emit` codes one token under its context and
// returns the token, which lets the decoder drive the same walk by returning what it read.
export function walk(
  s: Structured | null, issueHour: number, emit: (field: FieldName, context: string | null, token: string | null) => string,
): Structured {
  const out: Structured = { issueHour, validity: "", ratings: [], confidence: "", problems: [] };
  out.validity = emit("validity", null, s ? s.validity : null);
  const days = Number(emit("dayCount", null, s ? String(s.ratings.length) : null));
  for (let d = 0; d < days; d++) {
    const day = { date: "", alp: "", tln: "", btl: "" };
    day.date = emit("date", d === 0 ? `issued|${issueHour}` : "next", s ? s.ratings[d].date : null);
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
  constructor(readonly fields: Map<FieldName, Field>) {}

  field(name: FieldName): Field {
    const f = this.fields.get(name);
    if (!f) throw new Error(`structured: no field ${name}`);
    return f;
  }

  // Appends the decisions for `s` to `plan`. The byte table comes from the prose model so
  // literals share one table.
  plan(plan: Decision[], byteTable: Table, s: Structured): void {
    walk(s, s.issueHour, (field, context, token) => {
      const f = this.field(field);
      planToken(plan, f.stream, byteTable, [ctx(f, context)], token!);
      return token!;
    });
  }

  read(dec: Decoder, byteTable: Table, issueHour: number): Structured {
    return walk(null, issueHour, (field, context) => {
      const f = this.field(field);
      return readToken(dec, f.stream, byteTable, [ctx(f, context)])[0];
    });
  }

  bits(byteTable: Table, s: Structured): number {
    const plan: Decision[] = [];
    this.plan(plan, byteTable, s);
    let bits = 0;
    for (const [table, sym] of plan) bits += costBits(table, sym);
    return bits;
  }
}
