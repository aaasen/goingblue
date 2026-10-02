import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const satellite = vi.hoisted(() => ({ on: false }));
vi.mock('../modules/ultra-constrained', () => ({ isUltraConstrained: () => satellite.on }));

import { fetchText, FetchTimeoutError } from '../network';

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
