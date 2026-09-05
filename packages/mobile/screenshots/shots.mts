import { MODE_AUTO, VAR, WIND_LEVEL_VARS, type DeviceCode, type Variable } from '@weather/protocol';

// The App Store screenshot set, defined as the requests behind each shot. A shot is one location
// and one or more requests at it; every request becomes a saved forecast in the seeded app, and
// a shot with several becomes a compare group. The weather itself is recorded once per shot
// (scripts/record-shot.mts) and replayed through the current codec at seed time
// (scripts/seed-shots.mts), so this table plus the recorded upstream bytes is the whole input.

export type ModelName = 'best' | 'us' | 'ca' | 'eu' | 'de';

export interface ShotRequest {
  model: ModelName;
  // User-configurable additions only; the core variables are implicit in every request.
  vars: readonly Variable[];
}

export interface Shot {
  name: string;
  lat: number;
  lon: number;
  mode: number;
  device: DeviceCode;
  messages: number;
  requests: readonly ShotRequest[];
}

// Internet: the uncapped route, so every shot carries the whole forecast at full resolution.
const INTERNET = { device: 'd' as DeviceCode, messages: 1 };

// 400/500/600 hPa: the ladder runs 300..925 highest first, so these are indices 1..3.
const WIND_400_600 = WIND_LEVEL_VARS.slice(1, 4);

export const SHOTS: readonly Shot[] = [
  {
    name: 'denali', lat: 63.0692, lon: -151.0070, mode: MODE_AUTO, ...INTERNET,
    requests: [{ model: 'best', vars: [VAR.dewpoint, VAR.freeze, ...WIND_400_600] }],
  },
  {
    // Monte Fitz Roy's summit. One request per center, all with the agreement column, so the
    // compare pills group them.
    name: 'fitz-roy', lat: -49.27125, lon: -73.04321, mode: MODE_AUTO, ...INTERNET,
    requests: (['us', 'ca', 'eu', 'de'] as const).map((model) => ({ model, vars: [VAR.dewpoint, VAR.agreement] })),
  },
  {
    // The summit, as OpenStreetMap places it.
    name: 'jiehkkevarri', lat: 69.46921, lon: 19.87873, mode: MODE_AUTO, ...INTERNET,
    requests: [{ model: 'best', vars: [VAR.dewpoint, VAR.clouds] }],
  },
  {
    // Eldorado Peak, North Cascades. The US air-quality scale in full.
    name: 'eldorado-peak', lat: 48.53752, lon: -121.13440, mode: MODE_AUTO, ...INTERNET,
    requests: [{ model: 'best', vars: [VAR.precip, VAR.aqi, VAR.aq_pm25, VAR.aq_o3, VAR.aq_pm10, VAR.aq_no2, VAR.aq_so2] }],
  },
  {
    // The overview shot. Last so the earlier shots keep their message codes.
    name: 'mont-blanc', lat: 45.8326, lon: 6.8652, mode: MODE_AUTO, ...INTERNET,
    requests: [{ model: 'best', vars: [VAR.dewpoint, VAR.freeze, VAR.clouds] }],
  },
];

// A well-formed account token that no account was ever minted for. The codec server only checks
// the token's shape; accounts are the gateway's business, and the seeded app never reaches it.
export const SEED_TOKEN = 'SCRN5H0TF1XTVRE5';

// The preferences the seeded app runs under, as AsyncStorage key → value. The keys and value
// formats are settings.ts's; test/shot-fixtures.test.ts reads them back through its loaders so a
// change there fails here rather than seeding a silently ignored key.
export const SEED_SETTINGS: Record<string, string> = {
  display_unit_prefs: JSON.stringify({
    system: 'imperial', temp: 'f', rain: 'in', snow: 'in', wind: 'mph', altitude: 'ft', level: 'ft',
  }),
  time_format: '12h',
  aqi_scale: 'us',
  builder_device: 'internet',
};
