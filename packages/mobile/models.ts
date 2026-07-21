import { MODEL_BIT } from '@weather/protocol';

// `value` uppercases to a MODEL_BIT key (BEST/US/CA/EU); it's also the `m:` request token.
export const MODELS = [
  { value: 'best', label: 'Auto' },
  { value: 'us', label: 'American' },
  { value: 'ca', label: 'Canadian' },
  { value: 'eu', label: 'European' },
];

export function modelLabelsFromMask(mask: number): string[] {
  return MODELS
    .filter((model) => mask & (1 << MODEL_BIT[model.value.toUpperCase()]))
    .map((model) => model.label);
}
