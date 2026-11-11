/**
 * A bulletin's prose as sections, in a fixed order:
 *   highlights          the bottom line, when not empty
 *   problem             one per problem, always, so the k-th is the k-th problem's description
 *   advice              one per advice item
 *   avalanche-summary   when not empty
 *   snowpack-summary    when not empty
 *   hazard-discussion   when not empty
 *   weather-summary     one per weather period, as "label\ntext" (the label is "" when absent)
 *   confidence          one per confidence statement
 *   author              when not empty
 *
 * Because the order is fixed and the problems are counted by the structured fields, the layout
 * token (the count of every other kind) says which sections a bulletin has.
 */
import type { AvalancheForecast } from "../avalanche.js";

export const SECTION_KINDS = [
  "highlights", "problem", "advice", "avalanche-summary", "snowpack-summary", "hazard-discussion",
  "weather-summary", "confidence", "author",
] as const;

export interface Section {
  kind: string;   // one of SECTION_KINDS
  text: string;
  context?: string;   // problem type for a problem description
}

const COUNTED = SECTION_KINDS.filter((k) => k !== "problem");

export function sectionsOf(f: AvalancheForecast): Section[] {
  const out: Section[] = [];
  if (f.bottomLine) out.push({ kind: "highlights", text: f.bottomLine });
  for (const p of f.problems) out.push({ kind: "problem", text: p.description, context: p.type });
  for (const a of f.advice) out.push({ kind: "advice", text: a });
  if (f.avalancheSummary) out.push({ kind: "avalanche-summary", text: f.avalancheSummary });
  if (f.snowpackSummary) out.push({ kind: "snowpack-summary", text: f.snowpackSummary });
  if (f.hazardDiscussion) out.push({ kind: "hazard-discussion", text: f.hazardDiscussion });
  for (const w of f.weather) out.push({ kind: "weather-summary", text: `${w.label}\n${w.text}` });
  for (const s of f.confidence.statements) out.push({ kind: "confidence", text: s });
  if (f.author) out.push({ kind: "author", text: f.author });
  return out;
}

// The count of each kind but problem, in SECTION_KINDS order: "1.2.0.1.0.1.0.1".
export function layoutOf(sections: readonly Section[]): string {
  return COUNTED.map((k) => sections.filter((s) => s.kind === k).length).join(".");
}

// The section kinds, in order, of a bulletin with this layout and problem count.
export function kindsOf(layout: string, problems: number): string[] {
  const counts = layout.split(".").map(Number);
  if (counts.length !== COUNTED.length || counts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`avalanche: bad section layout ${layout}`);
  }
  const out: string[] = [];
  for (const kind of SECTION_KINDS) {
    const n = kind === "problem" ? problems : counts[COUNTED.indexOf(kind)];
    for (let i = 0; i < n; i++) out.push(kind);
  }
  return out;
}
