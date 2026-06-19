import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isValidToken, normalizeToken } from '@weather/protocol';

// In a dev build on a physical device, `localhost` resolves to the phone itself, not the dev
// machine, so the API is unreachable. Constants.expoConfig.hostUri carries the Metro dev-server
// host:port (e.g. "192.168.x.x:8081"); reuse that host and target the API's port. Falls back to
// localhost (simulator / hostUri unavailable).
function devNativeApiBase(): string {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host ?? 'localhost'}:8080`;
}

// Base URL for the API. Account provisioning runs over normal internet during app setup (never
// over satellite), so it can talk to the server directly.
//   - dev web (Metro web): browser and API share localhost, so use an absolute cross-origin URL.
//   - dev native: derive the dev machine's host from Metro (see devNativeApiBase).
//   - production web: the server hosts this app at /app, so call it same-origin (relative). This
//     avoids CORS entirely and works regardless of host (localhost or going.blue).
//   - production native: no shared origin, so target the deployed server directly.
export const API_BASE = __DEV__
  ? Platform.OS === 'web'
    ? 'http://localhost:8080'
    : devNativeApiBase()
  : Platform.OS === 'web'
    ? ''
    : 'https://going.blue';

const TOKEN_KEY = 'user_token';

// The stored account token, or null if none is set yet (first run) or the stored value is
// somehow corrupt — either way the app falls back to the setup flow.
export async function loadToken(): Promise<string | null> {
  try {
    const t = await AsyncStorage.getItem(TOKEN_KEY);
    return t && isValidToken(t) ? normalizeToken(t) : null;
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, normalizeToken(token));
}

// Forget the stored token, sending the app back to the setup flow. The account still exists
// server-side; this only clears the local reference.
export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// Mint a new account on the server and persist the returned token. The account token only
// identifies the user for usage limits; messaging opt-in is consumer-initiated (the user opts
// in by texting a forecast request to the number), so creating an account records no consent.
export async function createAccount(): Promise<string> {
  const resp = await fetch(`${API_BASE}/account`, { method: 'POST' });
  if (!resp.ok) throw new Error(`Account creation failed (${resp.status})`);
  const { token } = await resp.json();
  if (typeof token !== 'string' || !isValidToken(token)) {
    throw new Error('Server returned an invalid token');
  }
  const normalized = normalizeToken(token);
  await saveToken(normalized);
  return normalized;
}

// Confirm an existing token is real before importing it. The caller should check
// isValidToken first (a local check-symbol test); this verifies the token exists server-side.
export async function verifyAccount(token: string): Promise<boolean> {
  const resp = await fetch(`${API_BASE}/account/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: normalizeToken(token) }),
  });
  if (!resp.ok) throw new Error(`Verification failed (${resp.status})`);
  const { valid } = await resp.json();
  return valid === true;
}
