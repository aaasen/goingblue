import AsyncStorage from '@react-native-async-storage/async-storage';

// Unit system for displaying decoded forecasts. Persisted across sessions so the choice the user
// makes at account creation (or later in Settings) sticks without re-selecting each launch.
export type Units = 'imperial' | 'metric';

const UNITS_KEY = 'display_units';
const DEFAULT_UNITS: Units = 'imperial';

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
