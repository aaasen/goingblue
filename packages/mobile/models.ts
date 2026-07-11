import { MODEL_BIT } from '@weather/protocol';

export const MODELS = [
  { value: 'hres', label: 'HRES' },
  { value: 'ifs', label: 'ECMWF' },
  { value: 'gfs', label: 'GFS' },
  { value: 'icon', label: 'ICON' },
];

export function modelLabelsFromMask(mask: number): string[] {
  return MODELS
    .filter((model) => mask & (1 << MODEL_BIT[model.value.toUpperCase()]))
    .map((model) => model.label);
}
