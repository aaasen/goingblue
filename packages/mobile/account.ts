import AsyncStorage from '@react-native-async-storage/async-storage';
import { isValidToken, normalizeToken } from '@weather/protocol';

// Account provisioning runs over normal internet during app setup (never over satellite), so
// it can talk to the server directly. Mirrors the forecast endpoint's dev/prod split.
export const API_BASE = __DEV__ ? 'http://localhost:8080' : 'https://going.blue';

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

// Mint a new account on the server and persist the returned token.
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
