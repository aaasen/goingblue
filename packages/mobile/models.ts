import { MODEL_BIT } from '@weather/protocol';

// `value` uppercases to a MODEL_BIT key (BEST/US/CA/EU/DE); it's also the `m:` request token.
// Labels pair a flag emoji with a short abbreviation so the model selector fits without
// clipping: 🌐 Auto = best match (auto-pick across centers, no single country), then the
// US / Canadian / European / German centers. On Android, where flag emojis fall back to
// letters, the abbreviation keeps the label readable.
export const MODELS = [
  { value: 'best', label: '🌐 Auto' },
  { value: 'us', label: '🇺🇸 US' },
  { value: 'ca', label: '🇨🇦 CA' },
  { value: 'eu', label: '🇪🇺 EU' },
  { value: 'de', label: '🇩🇪 DE' },
];

export function modelLabelsFromMask(mask: number): string[] {
  return MODELS
    .filter((model) => mask & (1 << MODEL_BIT[model.value.toUpperCase()]))
    .map((model) => model.label);
}

// Just the leading flag emoji from each matching label (drops the abbreviation).
export function modelIconsFromMask(mask: number): string[] {
  return modelLabelsFromMask(mask).map((label) => label.split(' ')[0]);
}
