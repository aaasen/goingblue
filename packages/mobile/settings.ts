import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_DEVICE, isDevice, type Device } from './devices';

// Unit system for displaying decoded forecasts. Persisted across sessions so the choice the user
// makes at account creation (or later in Settings) sticks without re-selecting each launch.
export type Units = 'imperial' | 'metric';
export type TimeFormat = '12h' | '24h';

const UNITS_KEY = 'display_units';
const TIME_FORMAT_KEY = 'time_format';
const DEVICE_KEY = 'builder_device';
const DEFAULT_UNITS: Units = 'metric';
const DEFAULT_TIME_FORMAT: TimeFormat = '24h';

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
