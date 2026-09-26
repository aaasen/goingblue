/**
 * Training for the structured coder (packages/protocol/src/avalanche-codec/structured.ts): one
 * order-1 stream per field, counted under the same walk the codec codes with.
 */
import { BOS, Vocab } from "@weather/protocol/avalanche-codec/model";
import { FIELDS, StructuredModel, walk, type Field, type FieldName, type Structured } from "@weather/protocol/avalanche-codec/structured";
import { StreamBuilder } from "./model.ts";

class FieldBuilder {
  readonly stream = new StreamBuilder(1);
  readonly contexts = new Vocab();

  observe(token: string, context: string | null): void {
    this.stream.observe([token], [[context === null ? BOS : this.contexts.intern(context)]]);
  }

  build(): Field {
    return { stream: this.stream.build(), contexts: this.contexts };
  }
}

export class StructuredBuilder {
  readonly fields = new Map<FieldName, FieldBuilder>(FIELDS.map((f) => [f, new FieldBuilder()]));

  observe(s: Structured): void {
    walk(s, (field, context, token) => {
      this.fields.get(field)!.observe(token!, context);
      return token!;
    });
  }

  build(): StructuredModel {
    return new StructuredModel(new Map([...this.fields].map(([name, f]) => [name, f.build()])));
  }
}
