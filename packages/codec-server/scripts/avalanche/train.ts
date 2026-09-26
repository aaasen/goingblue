/**
 * Trains the avalanche models: the prose model and the structured coder over the same
 * forecasts.
 */
import type { AvalancheForecast, Models } from "@weather/protocol";
import { sectionsOf } from "@weather/protocol";
import { structuredOf } from "@weather/protocol/avalanche-codec/structured";
import { ModelBuilder } from "./model.ts";
import { StructuredBuilder } from "./structured.ts";

export function train(forecasts: Iterable<AvalancheForecast>, wordOrder?: number, minCount = 1): Models {
  const prose = new ModelBuilder(wordOrder);
  const structured = new StructuredBuilder();
  for (const f of forecasts) {
    for (const s of sectionsOf(f)) prose.observe(s);
    structured.observe(structuredOf(f));
  }
  return { prose: prose.build(minCount), structured: structured.build() };
}
