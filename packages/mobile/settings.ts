import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_DEVICE, isDevice, type Device } from './devices';

// Units for displaying decoded forecasts: one master switch and one unit per quantity the app
// draws. The master switch is the quick path — US or metric sets every quantity to that system's
// standard unit in one tap — and the per-quantity rows are for the reader whose habits don't
// follow a system: a sailor in knots, a Scandinavian in m/s, a pilot reading levels in hPa. The
// two compose by one rule (applyUnitSystem): flipping the master rewrites only the quantities
// currently on a US-or-metric unit, so a knots or hPa choice survives the flip. Persisted across
// sessions so the choice made at account creation (or later in Settings) sticks.
//
// Not units, and so not here: the air-quality scale (below — US and European AQI aren't
// convertible, and the scale is chosen at request time) and the time format.
export type Units = 'imperial' | 'metric';
export type TempUnit = 'f' | 'c';
export type RainUnit = 'in' | 'mm';
export type SnowUnit = 'in' | 'cm';
// Every wind column on the wire is quantized to extended Beaufort (see @weather/protocol
// quantWind), and the decoder hands back each band's midpoint — so Beaufort is the lossless
// reading and the speeds are all rendered midpoints. Knots earn their place as the convention
// for winds aloft.
export type WindUnit = 'mph' | 'kmh' | 'ms' | 'kt' | 'bft';
// Heights above sea level: the forecast point's elevation and the freezing level.
export type AltitudeUnit = 'ft' | 'm';
// The pressure-level ladder — the cloud band's rungs and the wind-aloft levels. ft and m label
// each level by its standard-atmosphere height; hPa names the pressure the wire carries.
export type LevelUnit = 'ft' | 'm' | 'hpa';

export interface UnitPrefs {
  system: Units;
  temp: TempUnit;
  rain: RainUnit;
  snow: SnowUnit;
  wind: WindUnit;
  altitude: AltitudeUnit;
  level: LevelUnit;
}

// A selectable unit, in selector order, with the label the toggle shows. `system` marks the
// unit as one system's standard — the one the master switch lands on, and the only kind the
// master switch overwrites. A unit with no system (knots, Beaufort, m/s, hPa) is a deliberate
// choice outside either, and neither setting of the master touches it.
export interface UnitOption<T extends string> { value: T; label: string; system?: Units }

export const TEMP_UNITS: readonly UnitOption<TempUnit>[] = [
  { value: 'f', label: '°F', system: 'imperial' },
  { value: 'c', label: '°C', system: 'metric' },
];
export const RAIN_UNITS: readonly UnitOption<RainUnit>[] = [
  { value: 'in', label: 'in', system: 'imperial' },
  { value: 'mm', label: 'mm', system: 'metric' },
];
export const SNOW_UNITS: readonly UnitOption<SnowUnit>[] = [
  { value: 'in', label: 'in', system: 'imperial' },
  { value: 'cm', label: 'cm', system: 'metric' },
];
export const WIND_UNITS: readonly UnitOption<WindUnit>[] = [
  { value: 'mph', label: 'mph', system: 'imperial' },
  { value: 'kmh', label: 'km/h', system: 'metric' },
  { value: 'ms', label: 'm/s' },
  { value: 'kt', label: 'kt' },
  { value: 'bft', label: 'bft' },
];
export const ALTITUDE_UNITS: readonly UnitOption<AltitudeUnit>[] = [
  { value: 'ft', label: 'ft', system: 'imperial' },
  { value: 'm', label: 'm', system: 'metric' },
];
export const LEVEL_UNITS: readonly UnitOption<LevelUnit>[] = [
  { value: 'ft', label: 'ft', system: 'imperial' },
  { value: 'm', label: 'm', system: 'metric' },
  { value: 'hpa', label: 'hPa' },
];

function standardOf<T extends string>(options: readonly UnitOption<T>[], system: Units): T {
  return options.find((o) => o.system === system)!.value;
}

// Every quantity on one system's standard unit.
export function defaultUnitPrefs(system: Units): UnitPrefs {
  return {
    system,
    temp: standardOf(TEMP_UNITS, system),
    rain: standardOf(RAIN_UNITS, system),
    snow: standardOf(SNOW_UNITS, system),
    wind: standardOf(WIND_UNITS, system),
    altitude: standardOf(ALTITUDE_UNITS, system),
    level: standardOf(LEVEL_UNITS, system),
  };
}

// The master switch's one rule: a quantity sitting on EITHER system's standard unit moves to the
// new system's; a quantity on a unit outside both systems stays where the reader put it.
function follow<T extends string>(options: readonly UnitOption<T>[], current: T, system: Units): T {
  return options.find((o) => o.value === current)?.system ? standardOf(options, system) : current;
}

export function applyUnitSystem(prefs: UnitPrefs, system: Units): UnitPrefs {
  return {
    system,
    temp: follow(TEMP_UNITS, prefs.temp, system),
    rain: follow(RAIN_UNITS, prefs.rain, system),
    snow: follow(SNOW_UNITS, prefs.snow, system),
    wind: follow(WIND_UNITS, prefs.wind, system),
    altitude: follow(ALTITUDE_UNITS, prefs.altitude, system),
    level: follow(LEVEL_UNITS, prefs.level, system),
  };
}

export type TimeFormat = '12h' | '24h';

// Which air-quality index the app works in. Unlike units this isn't a conversion — the US and
// European indices are separate scales built from different averaging windows and breakpoints, so
// the same number means different things on each and there's no arithmetic between them. It's a
// preference rather than a per-request choice for that reason: a reader learns one scale's
// categories and stays there, and picking it once keeps the builder from offering both.
export type AqiScale = 'us' | 'eu';

// The scales, in selector order, with the label the toggle and the builder's heading share.
export const AQI_SCALES: { value: AqiScale; label: string }[] = [
  { value: 'us', label: 'US' },
  { value: 'eu', label: 'Europe' },
];

// The master switch alone, as builds before the per-quantity units stored it — read once as the
// seed for a reader upgrading, never written.
const LEGACY_UNITS_KEY = 'display_units';
const UNIT_PREFS_KEY = 'display_unit_prefs';
const TIME_FORMAT_KEY = 'time_format';
const AQI_SCALE_KEY = 'aqi_scale';
const DEVICE_KEY = 'builder_device';
const TWO_MESSAGES_KEY = 'builder_two_messages';
const DEFAULT_TWO_MESSAGES = true;
const DEFAULT_SYSTEM: Units = 'imperial';
const DEFAULT_TIME_FORMAT: TimeFormat = '12h';
// The US index is the default because it's the one this app's readers are most likely to know:
// the forecast number is a US number and the air-quality question that drives the feature is
// wildfire smoke over the western US.
const DEFAULT_AQI_SCALE: AqiScale = 'us';

function pick<T extends string>(options: readonly UnitOption<T>[], value: unknown, system: Units): T {
  return options.some((o) => o.value === value) ? (value as T) : standardOf(options, system);
}

// Each field is validated on its own against the current options, and anything unreadable falls
// back to the master switch's standard — a unit dropped by a later build can't strand its row.
export async function loadUnits(): Promise<UnitPrefs> {
  try {
    const raw = await AsyncStorage.getItem(UNIT_PREFS_KEY);
    if (raw == null) {
      const legacy = await AsyncStorage.getItem(LEGACY_UNITS_KEY);
      return defaultUnitPrefs(legacy === 'metric' || legacy === 'imperial' ? legacy : DEFAULT_SYSTEM);
    }
    const v: Record<string, unknown> = JSON.parse(raw);
    const system: Units = v.system === 'metric' || v.system === 'imperial' ? v.system : DEFAULT_SYSTEM;
    return {
      system,
      temp: pick(TEMP_UNITS, v.temp, system),
      rain: pick(RAIN_UNITS, v.rain, system),
      snow: pick(SNOW_UNITS, v.snow, system),
      wind: pick(WIND_UNITS, v.wind, system),
      altitude: pick(ALTITUDE_UNITS, v.altitude, system),
      level: pick(LEVEL_UNITS, v.level, system),
    };
  } catch {
    return defaultUnitPrefs(DEFAULT_SYSTEM);
  }
}

export async function saveUnits(units: UnitPrefs): Promise<void> {
  try { await AsyncStorage.setItem(UNIT_PREFS_KEY, JSON.stringify(units)); } catch { /* ignore */ }
}

export async function loadTimeFormat(): Promise<TimeFormat> {
  try {
    const value = await AsyncStorage.getItem(TIME_FORMAT_KEY);
    return value === '12h' || value === '24h' ? value : DEFAULT_TIME_FORMAT;
  } catch {
    return DEFAULT_TIME_FORMAT;
  }
}

export async function saveTimeFormat(format: TimeFormat): Promise<void> {
  try { await AsyncStorage.setItem(TIME_FORMAT_KEY, format); } catch { /* ignore */ }
}

export async function loadAqiScale(): Promise<AqiScale> {
  try {
    const value = await AsyncStorage.getItem(AQI_SCALE_KEY);
    return AQI_SCALES.some((s) => s.value === value) ? (value as AqiScale) : DEFAULT_AQI_SCALE;
  } catch {
    return DEFAULT_AQI_SCALE;
  }
}

export async function saveAqiScale(scale: AqiScale): Promise<void> {
  try { await AsyncStorage.setItem(AQI_SCALE_KEY, scale); } catch { /* ignore */ }
}

// The device the builder sends through. Persisted because it's a property of what the user carries
// rather than a per-request choice: the phone that went out with an inReach last weekend is going
// out with it again. Anything not in the current device list reads back as the default, so a value
// left by an older build can't strand the selector on an option that no longer exists.
export async function loadDevice(): Promise<Device> {
  try {
    const value = await AsyncStorage.getItem(DEVICE_KEY);
    return isDevice(value) ? value : DEFAULT_DEVICE;
  } catch {
    return DEFAULT_DEVICE;
  }
}

export async function saveDevice(device: Device): Promise<void> {
  try { await AsyncStorage.setItem(DEVICE_KEY, device); } catch { /* ignore */ }
}

// Whether a messaging reply may span two messages instead of one. Persisted for the same
// reason as the device: it's a standing choice about how you use the thing you carry, not a
// per-request one. Defaults ON — one message is a thin forecast, and the reader who turned this
// off did so knowing that, where a reader who never saw it did not.
export async function loadTwoMessages(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(TWO_MESSAGES_KEY);
    return value === null ? DEFAULT_TWO_MESSAGES : value === 'true';
  } catch {
    return DEFAULT_TWO_MESSAGES;
  }
}

export async function saveTwoMessages(on: boolean): Promise<void> {
  try { await AsyncStorage.setItem(TWO_MESSAGES_KEY, String(on)); } catch { /* ignore */ }
}

// Forget every stored preference, the pre-per-quantity master switch included. Part of account
// deletion: the next launch starts from the defaults as a fresh install would.
export async function clearSettings(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([
      LEGACY_UNITS_KEY, UNIT_PREFS_KEY, TIME_FORMAT_KEY, AQI_SCALE_KEY, DEVICE_KEY, TWO_MESSAGES_KEY,
    ]);
  } catch { /* ignore */ }
}
