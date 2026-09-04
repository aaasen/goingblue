import { MODEL_BIT } from '@weather/protocol';

// `value` uppercases to a MODEL_BIT key (BEST/US/CA/EU/DE); it's also the `m:` request token.
// Labels are the model family names where one covers the whole chain (GEM, ICON) and the
// center's name where it doesn't (NOAA serves HRRR and GFS; ECMWF is the everyday name for
// the IFS). Auto = best match across centers.
export const MODELS = [
  { value: 'best', label: 'Auto' },
  { value: 'us', label: 'NOAA' },
  { value: 'ca', label: 'GEM' },
  { value: 'eu', label: 'ECMWF' },
  { value: 'de', label: 'ICON' },
];

// A reply carries exactly one model, so the mask has exactly one bit set.
export function modelLabelFromMask(mask: number): string {
  const model = MODELS.find((m) => mask & (1 << MODEL_BIT[m.value.toUpperCase()]));
  return model ? model.label : '';
}
