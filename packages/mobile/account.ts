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
// over satellite), so it can talk to the server directly. In dev, EXPO_PUBLIC_API_BASE wins when
// set (dev.sh tunnel mode, where Metro's host is an ngrok hostname with no gateway behind it);
// otherwise derive the dev machine's host from Metro (see devNativeApiBase). In production,
// target the deployed server.
export const API_BASE = __DEV__
  ? (process.env.EXPO_PUBLIC_API_BASE ?? devNativeApiBase())
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

// Forget the stored token, sending the app back to the setup flow. This only clears the local
// reference — see deleteAccount for erasing the account itself.
export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// Erase the account server-side. Throws if the server can't be reached or answers with an error,
// which the caller must surface rather than swallow: dropping the local token after a failed
// delete would leave a live account with no way left to reach it. An unknown token is not a
// failure — the server reports deleted:false and we treat the account as gone, which is the
// state the caller wanted.
export async function deleteAccount(token: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/account/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: normalizeToken(token) }),
  });
  if (!resp.ok) throw new Error(`Account deletion failed (${resp.status})`);
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
