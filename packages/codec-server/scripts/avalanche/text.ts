/**
 * Bulletin prose extraction. The API delivers every text field as an HTML fragment; the codec
 * models plain text, so this is the one place HTML is turned into the strings that get
 * compressed. Everything downstream (tokenizer, model, metrics) sees only the output of
 * bulletinSections().
 */

import { extractStructured, type Structured } from "./structured.ts";

export interface Section {
  kind: string;   // highlights | avalanche-summary | snowpack-summary | weather-summary | problem | advice
  text: string;
}

export interface BulletinProse {
  id: string;
  owner: string;
  dateIssued: string;
  sections: Section[];
  text: string;   // all sections joined, the document the codec compresses
  structured: Structured;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  deg: "°", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Block-level closers become paragraph breaks, every other tag disappears, whitespace collapses
// within lines and blank runs collapse to one blank line.
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|li|h\d|tr)\s*>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/ /g, " ");
  const lines = s.split("\n").map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface RawProduct {
  id: string;
  owner: { value: string };
  report: {
    dateIssued: string;
    highlights?: string | null;
    summaries?: { type: { value: string }; content: string | null }[];
    problems?: { comment?: string | null }[];
    terrainAndTravelAdvice?: string[];
    dangerRatings?: { ratings: Record<string, { rating: { value: string } }> }[];
  };
}

const RATED = new Set(["low", "moderate", "considerable", "high", "extreme"]);

// A bulletin with a real danger rating somewhere. Off-season placeholders and "no rating"
// regions carry boilerplate, not forecasts, and are excluded from the corpus.
export function isForecast(p: RawProduct): boolean {
  return (p.report.dangerRatings ?? []).some((d) =>
    Object.values(d.ratings ?? {}).some((r) => RATED.has(r.rating?.value)),
  );
}

export function bulletinSections(p: RawProduct): Section[] {
  const r = p.report;
  const out: Section[] = [];
  const push = (kind: string, html: string | null | undefined) => {
    const text = htmlToText(html);
    if (text) out.push({ kind, text });
  };
  push("highlights", r.highlights);
  for (const pr of r.problems ?? []) push("problem", pr.comment);
  for (const a of r.terrainAndTravelAdvice ?? []) push("advice", a);
  for (const s of r.summaries ?? []) push(s.type.value, s.content);
  return out;
}

export function bulletinProse(p: RawProduct): BulletinProse {
  const sections = bulletinSections(p);
  return {
    id: p.id,
    owner: p.owner.value,
    dateIssued: p.report.dateIssued,
    sections,
    text: sections.map((s) => s.text).join("\n\n"),
    structured: extractStructured(p as Parameters<typeof extractStructured>[0]),
  };
}
