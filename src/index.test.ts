import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShabbatGate } from './index.js';

function fakeCache() {
  const store = new Map<string, Response>();
  return {
    match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
    put: vi.fn(async (req: Request, res: Response) => {
      store.set(req.url, res.clone());
    }),
  };
}

function makeContext(request: Request) {
  const next = vi.fn(async () => new Response('real site'));
  return { context: { request, next } as unknown as Parameters<ReturnType<typeof createShabbatGate>>[0], next };
}

// Both events must live in the same `items` array to pair into one window -
// Hebcal's shabbat endpoint returns candles + havdalah together for the same week.
const OPEN_WINDOW_ITEMS = [
  { title: 'Candle lighting', date: '2020-01-01T00:00:00.000Z', category: 'candles' },
  { title: 'Havdalah', date: '2099-01-01T00:00:00.000Z', category: 'havdalah' },
];

describe('createShabbatGate', () => {
  beforeEach(() => {
    // @ts-expect-error - test-only global stub for the Workers Cache API
    globalThis.caches = { default: fakeCache() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets bots through unconditionally, without even checking the calendar', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context, next } = makeContext(
      new Request('https://example.com/', { headers: { 'user-agent': 'Googlebot/2.1' } }),
    );

    const response = await gate(context);

    expect(next).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await response.text()).toBe('real site');
  });

  it('lets the request through when the bypass param matches, even inside an open window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const items = String(url).includes('/shabbat?') ? OPEN_WINDOW_ITEMS : [];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });

    const gate = createShabbatGate({
      siteName: 'Test Site',
      bypassParam: 'preview',
      bypassValue: 'letmein-123',
    });
    const { context, next } = makeContext(new Request('https://example.com/?preview=letmein-123'));

    await gate(context);

    expect(next).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not bypass, and still shows the holding page, with a missing or wrong bypass value', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const items = String(url).includes('/shabbat?') ? OPEN_WINDOW_ITEMS : [];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });

    const gate = createShabbatGate({
      siteName: 'Test Site',
      bypassParam: 'preview',
      bypassValue: 'letmein-123',
    });
    const { context, next } = makeContext(new Request('https://example.com/?preview=wrong'));

    const response = await gate(context);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Test Site');
  });

  it('fails open (lets the real site through) when the Hebcal fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context, next } = makeContext(new Request('https://example.com/'));

    const response = await gate(context);

    expect(next).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('real site');
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('serves the holding page when now falls inside an open window', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const items = String(url).includes('/shabbat?') ? OPEN_WINDOW_ITEMS : [];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });

    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context, next } = makeContext(new Request('https://example.com/'));

    const response = await gate(context);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Test Site');
  });
});
