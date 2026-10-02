import { isUltraConstrained } from './modules/ultra-constrained';

// Every request the app makes to its own API goes through fetchText, so the timeout rule lives
// only here. A connection the OS calls up but that carries nothing (a captive portal, a bar of
// stalled signal) otherwise hangs on the platform's own timeout, a minute of spinner with nothing
// to show for it. On a carrier satellite link every round trip is slow, and the connection setup
// alone takes several.
const TIMEOUT_MS = 20000;
const SATELLITE_TIMEOUT_MS = 60000;

export class FetchTimeoutError extends Error {
  constructor() {
    super('Request timed out');
    this.name = 'FetchTimeoutError';
  }
}

export interface TextResponse {
  ok: boolean;
  status: number;
  text: string;
}

// fetch plus reading the body, both inside one timeout. A timeout throws FetchTimeoutError; an
// abort through `init.signal` (the caller cancelling) throws whatever fetch throws for it.
// AbortController rather than AbortSignal.timeout, which React Native's fetch polyfill doesn't
// carry.
export async function fetchText(url: string, init: RequestInit = {}): Promise<TextResponse> {
  const controller = new AbortController();
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener('abort', onOuterAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, isUltraConstrained() ? SATELLITE_TIMEOUT_MS : TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    return { ok: resp.ok, status: resp.status, text: await resp.text() };
  } catch (e) {
    throw timedOut ? new FetchTimeoutError() : e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}
