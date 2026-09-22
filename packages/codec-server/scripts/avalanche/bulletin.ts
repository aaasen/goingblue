/**
 * A whole bulletin on the wire: the prose header, then one rANS stream holding the structured
 * fields followed by the prose sections. The structured part comes first so a later layout can
 * drop the prose's kind symbols and condition prose on the structure.
 */
import { frame, planSections, readHeader, readSections } from "./codec.ts";
import type { Model } from "./model.ts";
import { Decoder } from "./rans.ts";
import type { Section } from "./text.ts";
import type { Structured, StructuredModel } from "./structured.ts";

export interface Bulletin {
  structured: Structured;
  sections: Section[];
}

export function encodeBulletin(prose: Model, structured: StructuredModel, b: Bulletin): Uint8Array {
  const { header, plan } = planSections(prose, b.sections);
  const all = [] as typeof plan;
  structured.plan(all, prose.byteTable(), b.structured);
  all.push(...plan);
  return frame(header, all);
}

export function decodeBulletin(prose: Model, structured: StructuredModel, blob: Uint8Array): Bulletin {
  const { wordCounts, pos } = readHeader(blob);
  const dec = new Decoder(blob, pos);
  const s = structured.read(dec, prose.byteTable());
  const contextFor = (kind: string, index: number) => (kind === "problem" ? s.problems[index]?.type : undefined);
  return { structured: s, sections: readSections(prose, dec, wordCounts, contextFor) };
}
