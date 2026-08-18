import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_DEVICE, isDevice, type Device } from './devices';

// Unit system for displaying decoded forecasts. Persisted across sessions so the choice the user
// makes at account creation (or later in Settings) sticks without re-selecting each launch.
export type Units = 'imperial' | 'metric';
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

const UNITS_KEY = 'display_units';
const TIME_FORMAT_KEY = 'time_format';
const AQI_SCALE_KEY = 'aqi_scale';
const DEVICE_KEY = 'builder_device';
const TWO_MESSAGES_KEY = 'builder_two_messages';
const DEFAULT_TWO_MESSAGES = true;
const DEFAULT_UNITS: Units = 'imperial';
const DEFAULT_TIME_FORMAT: TimeFormat = '12h';
// The US index is the default because it's the one this app's readers are most likely to know:
// the forecast number is a US number and the air-quality question that drives the feature is
// wildfire smoke over the western US.
const DEFAULT_AQI_SCALE: AqiScale = 'us';

export async function loadUnits(): Promise<Units> {
  try {
    const v = await AsyncStorage.getItem(UNITS_KEY);
    return v === 'metric' || v === 'imperial' ? v : DEFAULT_UNITS;
  } catch {
    return DEFAULT_UNITS;
  }
}

export async function saveUnits(units: Units): Promise<void> {
  try { await AsyncStorage.setItem(UNITS_KEY, units); } catch { /* ignore */ }
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

// Whether an iPhone satellite reply may span two messages instead of one. Persisted for the same
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
