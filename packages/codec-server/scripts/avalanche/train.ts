/**
 * Trains the structured coder and, for the benchmarks, the word-Markov prose model over the same
 * forecasts.
 */
import type { AvalancheForecast } from "@weather/protocol";
import { sectionsOf } from "@weather/protocol";
import type { Model } from "@weather/protocol/avalanche-codec/model";
import { structuredOf, type StructuredModel } from "@weather/protocol/avalanche-codec/structured";
import { ModelBuilder } from "./model.ts";
import { StructuredBuilder } from "./structured.ts";

export function train(forecasts: Iterable<AvalancheForecast>, wordOrder?: number, minCount = 1): { prose: Model; structured: StructuredModel } {
  const prose = new ModelBuilder(wordOrder);
  const structured = new StructuredBuilder();
  for (const f of forecasts) {
    for (const s of sectionsOf(f)) prose.observe(s);
    structured.observe(structuredOf(f));
  }
  return { prose: prose.build(minCount), structured: structured.build() };
}
