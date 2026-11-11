/**
 * A whole forecast on the wire, as two rANS streams back to back:
 *
 *   A  the piece set (region.ts), the structured fields with the section layout (structured.ts,
 *      sections.ts), and B's length in bytes
 *   B  the prose sections (prose.ts), coded by the neural prose model
 *
 * A decodes to its own end, so B needs no offset. The encoder trims B's trailing zero bytes,
 * which the decoder reads back as zeros, so B ends in a nonzero byte and its length tells a
 * complete bulletin from one still missing messages without running the prose model.
 *
 * The issue time travels in the message header (wire.ts) and is handed to the decoder; the
 * expiry and the danger days' dates are coded relative to it. The issuing center, issuer,
 * region, and time zone are not on the wire because the client derives them: the center and
 * issuer from the decoded piece set, the region name and time zone from the forecast point. The
 * decoder fills them with UNENCODED.
 */
import {
  ASPECTS, ELEVATIONS,
  type AvalancheForecast, type AvalancheProblem, type Aspect, type Confidence, type DangerRating,
  type Elevation, type Likelihood, type ProblemType,
} from "../avalanche.js";
import { proseDoc, type ProseCoder, type ProseDoc } from "./prose.js";
import { buildTable, Decoder, encode as ransEncode, type Decision, type Table } from "./rans.js";
import { planRegion, readRegion } from "./region.js";
import { kindsOf, sectionsOf } from "./sections.js";
import { cellsOf, structuredOf, type Structured, type StructuredModel } from "./structured.js";
import { addDays, quantizeIssued, utcDate } from "./time.js";

export interface Models {
  structured: StructuredModel;
  prose: ProseCoder;
}

// Placeholders for the fields the client derives instead of reading off the wire.
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
  return { ...f, ...UNENCODED, issued, expires };
}

// B's length as v = length + 1: the bit length of v less one over a uniform table, then v's
// bits below its top bit.
const LENGTH_BITS = 24;
let widthTbl: Table | null = null;
const widthTable = (): Table => (widthTbl ??= buildTable(Array.from({ length: LENGTH_BITS }, (_, k): [number, number] => [k, 1])));
let bitTbl: Table | null = null;
const bitTable = (): Table => (bitTbl ??= buildTable([[0, 1], [1, 1]]));

function planLength(plan: Decision[], length: number): void {
  const v = length + 1;
  const k = Math.floor(Math.log2(v));
  if (k >= LENGTH_BITS) throw new Error(`avalanche: prose of ${length} bytes`);
  plan.push([widthTable(), k]);
  for (let i = k - 1; i >= 0; i--) plan.push([bitTable(), Math.floor(v / 2 ** i) % 2]);
}

function readLength(dec: Decoder): number {
  let v = 1;
  for (let k = dec.get(widthTable()); k > 0; k--) v = v * 2 + dec.get(bitTable());
  return v - 1;
}

function dates(s: Structured, issued: number): string[] {
  const out: string[] = [];
  for (const d of s.ratings) out.push(addDays(out.length === 0 ? utcDate(issued) : out[out.length - 1], Number(d.date)));
  return out;
}

// `texts` holds one text per section of the layout, in order.
function forecastOf(pieces: number[], s: Structured, texts: readonly string[], issued: number): AvalancheForecast {
  const kinds = kindsOf(s.layout, s.problems.length);
  const of = (kind: string) => texts.filter((_, i) => kinds[i] === kind);
  const descriptions = of("problem");
  const problems: AvalancheProblem[] = s.problems.map((p, i) => {
    const [min, max] = p.size.split("-").map(Number);
    const cells = cellsOf(p.aspects);
    return {
      type: p.type as ProblemType,
      elevations: cells ? ELEVATIONS.filter((e) => cells.some((c) => c.elevation === e)) : p.elevations as Elevation[],
      aspects: cells ? ASPECTS.filter((a) => cells.some((c) => c.aspect === a)) : p.aspects as Aspect[],
      ...(cells ? { cells } : {}),
      likelihood: p.likelihood as Likelihood,
      size: { min, max },
      description: descriptions[i] ?? "",
    };
  });
  return {
    center: UNENCODED.center,
    issuedBy: UNENCODED.issuedBy,
    author: of("author")[0] ?? "",
    region: UNENCODED.region,
    pieces,
    issued,
    expires: s.validity === "" ? NaN : issued + Number(s.validity) * 60000,
    timezone: UNENCODED.timezone,
    bottomLine: of("highlights")[0] ?? "",
    danger: dates(s, issued).map((date, i) => ({
      date,
      btl: s.ratings[i].btl as DangerRating,
      tln: s.ratings[i].tln as DangerRating,
      alp: s.ratings[i].alp as DangerRating,
    })),
    advice: of("advice"),
    problems,
    avalancheSummary: of("avalanche-summary")[0] ?? "",
    snowpackSummary: of("snowpack-summary")[0] ?? "",
    hazardDiscussion: of("hazard-discussion")[0] ?? "",
    weather: of("weather-summary").map((t) => {
      const cut = t.indexOf("\n");
      return { label: t.slice(0, cut), text: t.slice(cut + 1) };
    }),
    confidence: { rating: s.confidence as Confidence | "noRating", statements: of("confidence") },
  };
}

export async function encodeBulletin({ structured, prose }: Models, f: AvalancheForecast): Promise<Uint8Array> {
  const issued = quantizeIssued(f.issued);
  const s = structuredOf(f);
  const b = await prose.encode(proseDoc(f.pieces, s, issued, sectionsOf(f).map((x) => x.text)));
  let length = b.length;
  while (length > 0 && b[length - 1] === 0) length--;
  const plan: Decision[] = [];
  planRegion(plan, f.pieces);
  structured.plan(plan, s);
  planLength(plan, length);
  const a = ransEncode(plan);
  const out = new Uint8Array(a.length + length);
  out.set(a);
  out.set(b.subarray(0, length), a.length);
  return out;
}

// A bulletin read up to its prose, which is cheap: everything but the section texts.
export interface BulletinHead {
  pieces: number[];
  structured: Structured;
  issued: number;
  // Stream B, and the doc its markers describe.
  prose: Uint8Array;
  layout: ProseDoc;
}

// Reads stream A and checks that all of B is there. Throws for bytes that are not a whole
// bulletin, including one still missing messages.
// `issued` is the issue time from the message header, already on its 15-minute step.
export function readBulletin(structured: StructuredModel, blob: Uint8Array, issued: number): BulletinHead {
  const dec = new Decoder(blob);
  const pieces = readRegion(dec);
  const s = structured.read(dec, new Date(issued).getUTCHours());
  const length = readLength(dec);
  const start = dec.end();
  if (start + length > blob.length) throw new Error("avalanche: the bulletin is incomplete");
  for (let i = start + length; i < blob.length; i++) {
    if (blob[i] !== 0) throw new Error("avalanche: bytes left over after the bulletin");
  }
  return { pieces, structured: s, issued, prose: blob.subarray(start, start + length), layout: proseDoc(pieces, s, issued) };
}

// The forecast a head holds, with the section texts when given and empty without them.
export function headForecast(head: BulletinHead, texts?: readonly string[]): AvalancheForecast {
  const t = texts ?? head.layout.sections.map(() => "");
  if (t.length !== head.layout.sections.length) throw new Error("avalanche: the prose has the wrong number of sections");
  return forecastOf(head.pieces, head.structured, t, head.issued);
}

export async function decodeBulletin({ structured, prose }: Models, blob: Uint8Array, issued: number): Promise<AvalancheForecast> {
  const head = readBulletin(structured, blob, issued);
  return headForecast(head, await prose.decode(head.prose, head.layout));
}
