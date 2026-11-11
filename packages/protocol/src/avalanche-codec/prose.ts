/**
 * The prose stream: section texts coded by the neural prose model (native/avalanche), which each
 * platform supplies as a ProseCoder.
 *
 * The model sees each forecast as context markers, then each section's markers, text and end.
 * The markers are built here from what both ends know before the prose: the piece set, the
 * structured fields and the issue time. A marker the model does not know is dropped on both
 * sides, so a new value costs prediction quality, never a decode.
 */
import { NAC_CENTERS } from "../avalanche-nac.gen.js";
import { AVALANCHE_PIECES } from "../avalanche-pieces.gen.js";
import { ASPECTS, ELEVATIONS } from "../avalanche.js";
import { kindsOf } from "./sections.js";
import { cellsOf, type Structured } from "./structured.js";

export interface ProseSection {
  markers: string[];
  // Absent in a layout handed to the decoder.
  text?: string;
}

export interface ProseDoc {
  markers: string[];
  sections: ProseSection[];
}

export interface ProseCoder {
  encode(doc: ProseDoc): Promise<Uint8Array>;
  // The section texts of `bytes`, which `encode` wrote for a doc with the markers of `layout`.
  decode(bytes: Uint8Array, layout: ProseDoc): Promise<string[]>;
}


// The doc for a bulletin, with the section texts when given (encoding) and without (decoding).
export function proseDoc(pieces: readonly number[], s: Structured, issued: number, texts?: readonly string[]): ProseDoc {
  const markers: string[] = [];
  const center = pieces.length ? AVALANCHE_PIECES[pieces[0]]?.center : undefined;
  if (center) markers.push(`center:${NAC_CENTERS[center]?.id ?? center}`);   // avalanche.org centers by their API ids
  markers.push(`month:${new Date(issued).toISOString().slice(5, 7)}`);
  s.ratings.slice(0, 3).forEach((d, i) => {
    for (const band of ["alp", "tln", "btl"] as const) markers.push(`d${i}${band}:${d[band]}`);
  });
  if (s.confidence !== "noRating") markers.push(`conf:${s.confidence}`);

  const kinds = kindsOf(s.layout, s.problems.length);
  if (texts && texts.length !== kinds.length) throw new Error(`avalanche: ${texts.length} sections for a layout of ${kinds.length}`);
  let problem = 0;
  const sections = kinds.map((kind, i): ProseSection => {
    const m = [`kind:${kind}`];
    if (kind === "problem") {
      const p = s.problems[problem++];
      const cells = cellsOf(p.aspects);
      const elevations = cells ? ELEVATIONS.filter((e) => cells.some((c) => c.elevation === e)) : p.elevations;
      const aspects = cells ? ASPECTS.filter((a) => cells.some((c) => c.aspect === a)) : p.aspects;
      m.push(`ptype:${p.type}`, `lk:${p.likelihood}`, `sz:${p.size}`, ...elevations.map((e) => `el:${e}`), ...aspects.map((a) => `as:${a}`));
      if (cells) m.push("cells:partial");
    }
    return texts ? { markers: m, text: texts[i] } : { markers: m };
  });
  return { markers, sections };
}
