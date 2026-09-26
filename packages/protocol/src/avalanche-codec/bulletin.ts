/**
 * A whole forecast on the wire: the prose header, then one rANS stream holding the piece set
 * (region.ts), the structured fields, and the prose sections. The structured part comes before
 * the prose so the problem sections can start from their problem's type.
 *
 * Prose sections, in order:
 *   highlights          the bottom line, when not empty
 *   problem             one per problem, always, so the k-th is the k-th problem's description
 *   advice              one per advice item
 *   avalanche-summary   when not empty
 *   snowpack-summary    when not empty
 *   weather-summary     one per weather period, as "label\ntext" (the label is "" when absent)
 *   confidence          one per confidence statement
 *
 * The issue time travels in the message header (wire.ts) and is handed to the decoder; the
 * expiry is coded relative to it. The issuing center, region, and time zone are not coded yet:
 * the decoder fills them with UNENCODED.
 */
import type {
  AvalancheForecast, AvalancheProblem, Aspect, Confidence, DangerRating, Elevation, Likelihood,
  ProblemType,
} from "../avalanche.js";
import { frame, planSections, readHeader, readSections } from "./codec.js";
import type { Model, Section } from "./model.js";
import { Decoder } from "./rans.js";
import { planRegion, readRegion } from "./region.js";
import { structuredOf, type Structured, type StructuredModel } from "./structured.js";
import { quantizeIssued } from "./time.js";

export const SECTION_KINDS = [
  "highlights", "problem", "advice", "avalanche-summary", "snowpack-summary", "weather-summary",
  "confidence",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// Placeholders for the fields the wire does not carry yet. Danger day i is dated i days after
// the epoch so the days stay distinct.
export const UNENCODED = {
  center: "",
  issuedBy: "",
  region: "",
  timezone: "UTC",
} as const;

// The forecast as it decodes: the coded fields kept, the issue time on its 15-minute step, the
// expiry to the minute, and the rest replaced by UNENCODED.
export function withPlaceholders(f: AvalancheForecast): AvalancheForecast {
  const issued = quantizeIssued(f.issued);
  const expires = Number.isFinite(f.expires) ? issued + Math.round((f.expires - issued) / 60000) * 60000 : NaN;
  return { ...f, ...UNENCODED, issued, expires, danger: f.danger.map((d, i) => ({ ...d, date: i * DAY_MS })) };
}

export function sectionsOf(f: AvalancheForecast): Section[] {
  const out: Section[] = [];
  if (f.bottomLine) out.push({ kind: "highlights", text: f.bottomLine });
  for (const p of f.problems) out.push({ kind: "problem", text: p.description, context: p.type });
  for (const a of f.advice) out.push({ kind: "advice", text: a });
  if (f.avalancheSummary) out.push({ kind: "avalanche-summary", text: f.avalancheSummary });
  if (f.snowpackSummary) out.push({ kind: "snowpack-summary", text: f.snowpackSummary });
  for (const w of f.weather) out.push({ kind: "weather-summary", text: `${w.label}\n${w.text}` });
  for (const s of f.confidence.statements) out.push({ kind: "confidence", text: s });
  return out;
}

function forecastOf(pieces: number[], s: Structured, sections: Section[], issued: number): AvalancheForecast {
  const texts = (kind: string) => sections.filter((x) => x.kind === kind).map((x) => x.text);
  const descriptions = texts("problem");
  const problems: AvalancheProblem[] = s.problems.map((p, i) => {
    const [min, max] = p.size.split("-").map(Number);
    return {
      type: p.type as ProblemType,
      elevations: p.elevations as Elevation[],
      aspects: p.aspects as Aspect[],
      likelihood: p.likelihood as Likelihood,
      size: { min, max },
      description: descriptions[i] ?? "",
    };
  });
  return {
    center: UNENCODED.center,
    issuedBy: UNENCODED.issuedBy,
    region: UNENCODED.region,
    pieces,
    issued,
    expires: s.validity === "" ? NaN : issued + Number(s.validity) * 60000,
    timezone: UNENCODED.timezone,
    bottomLine: texts("highlights")[0] ?? "",
    danger: s.ratings.map((d, i) => ({
      date: i * DAY_MS,
      btl: d.btl as DangerRating,
      tln: d.tln as DangerRating,
      alp: d.alp as DangerRating,
    })),
    advice: texts("advice"),
    problems,
    avalancheSummary: texts("avalanche-summary")[0] ?? "",
    snowpackSummary: texts("snowpack-summary")[0] ?? "",
    weather: texts("weather-summary").map((t) => {
      const cut = t.indexOf("\n");
      return { label: t.slice(0, cut), text: t.slice(cut + 1) };
    }),
    confidence: { rating: s.confidence as Confidence | "noRating", statements: texts("confidence") },
  };
}

export interface Models {
  prose: Model;
  structured: StructuredModel;
}

export function encodeBulletin({ prose, structured }: Models, f: AvalancheForecast): Uint8Array {
  const { header, plan } = planSections(prose, sectionsOf(f));
  const all = [] as typeof plan;
  planRegion(all, f.pieces);
  structured.plan(all, prose.byteTable(), structuredOf(f));
  all.push(...plan);
  return frame(header, all);
}

// `issued` is the issue time from the message header, already on its 15-minute step.
export function decodeBulletin({ prose, structured }: Models, blob: Uint8Array, issued: number): AvalancheForecast {
  const { wordCounts, pos } = readHeader(blob);
  const dec = new Decoder(blob, pos);
  const pieces = readRegion(dec);
  const s = structured.read(dec, prose.byteTable());
  const contextFor = (kind: string, index: number) => (kind === "problem" ? s.problems[index]?.type : undefined);
  return forecastOf(pieces, s, readSections(prose, dec, wordCounts, contextFor), issued);
}
