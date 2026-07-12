import AsyncStorage from '@react-native-async-storage/async-storage';

// Unit system for displaying decoded forecasts. Persisted across sessions so the choice the user
// makes at account creation (or later in Settings) sticks without re-selecting each launch.
export type Units = 'imperial' | 'metric';
export type TimeFormat = '12h' | '24h';

const UNITS_KEY = 'display_units';
const TIME_FORMAT_KEY = 'time_format';
const DEFAULT_UNITS: Units = 'imperial';
const DEFAULT_TIME_FORMAT: TimeFormat = '12h';

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
