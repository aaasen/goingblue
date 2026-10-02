import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const satellite = vi.hoisted(() => ({ on: false }));
vi.mock('../modules/ultra-constrained', () => ({ isUltraConstrained: () => satellite.on }));

import { fetchText, FetchNetworkError, FetchTimeoutError, requestErrorMessage } from '../network';

// A fetch that never answers until its signal aborts, as on a stalled link.
function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
}

describe('fetchText', () => {
  beforeEach(() => { vi.useFakeTimers(); satellite.on = false; });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('returns the status and body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello', { status: 201 })));
    await expect(fetchText('https://x')).resolves.toEqual({ ok: true, status: 201, text: 'hello' });
  });

  it('times out after 20 s normally', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const result = fetchText('https://x').catch((e) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(FetchTimeoutError);
  });

  it('waits 60 s on satellite', async () => {
    satellite.on = true;
    vi.stubGlobal('fetch', hangingFetch());
    let settled = false;
    const result = fetchText('https://x').catch((e) => e).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(FetchTimeoutError);
  });

  it('passes a caller abort through as an abort, not a timeout', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const result = fetchText('https://x', { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const e = await result;
    expect(e).not.toBeInstanceOf(FetchTimeoutError);
    expect(e.name).toBe('AbortError');
  });
});

describe('fetchText failures', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('wraps a failed connection in FetchNetworkError', async () => {
    const native = new TypeError('fetch failed: UnexpectedException: The internet connection appears to be offline');
    vi.stubGlobal('fetch', vi.fn(async () => { throw native; }));
    const e = await fetchText('https://x').catch((err) => err);
    expect(e).toBeInstanceOf(FetchNetworkError);
    expect(e.cause).toBe(native);
  });

  it('returns an error status instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(fetchText('https://x')).resolves.toEqual({ ok: false, status: 400, text: 'bad request' });
  });
});

describe('requestErrorMessage', () => {
  it('names each way a request fails and passes a server message through', () => {
    expect(requestErrorMessage(new FetchNetworkError(new TypeError('native')))).toBe('Not connected to the internet.');
    expect(requestErrorMessage(new FetchTimeoutError())).toBe('Request timed out.');
    expect(requestErrorMessage(new Error('Could not create account'))).toBe('Could not create account');
  });
});
