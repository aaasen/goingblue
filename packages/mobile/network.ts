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

// The request never got an answer: no route, DNS failure, connection refused or dropped. The
// platform's own error, kept as `cause`, is a long native message with a stack, not for display.
export class FetchNetworkError extends Error {
  constructor(cause: unknown) {
    super('Network request failed', { cause });
    this.name = 'FetchNetworkError';
  }
}

// The body of a failed request's error alert: a fixed line for each way the request can fail to
// get an answer, otherwise the message itself (a server error status's body, as the caller threw
// it).
export function requestErrorMessage(e: unknown): string {
  if (e instanceof FetchNetworkError) return 'Not connected to the internet.';
  if (e instanceof FetchTimeoutError) return 'Request timed out.';
  return e instanceof Error ? e.message : String(e);
}

export interface TextResponse {
  ok: boolean;
  status: number;
  text: string;
}

// fetch plus reading the body, both inside one timeout. A timeout throws FetchTimeoutError, any
// other failure to get an answer FetchNetworkError; an abort through `init.signal` (the caller
// cancelling) throws whatever fetch throws for it. An answer with an error status is returned,
// not thrown.
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
    if (timedOut) throw new FetchTimeoutError();
    if (outer?.aborted) throw e;
    throw new FetchNetworkError(e);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}
