import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShabbatGate, createShabbatGateForWorker } from './index.js';

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

// A single merged `items` array, as returned by the one `/hebcal` call
// fetchWindows now makes - candles + havdalah for the same week pair into
// one window regardless of what else is mixed in around them.
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ items: OPEN_WINDOW_ITEMS }), { status: 200 });
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ items: OPEN_WINDOW_ITEMS }), { status: 200 });
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ items: OPEN_WINDOW_ITEMS }), { status: 200 });
    });

    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context, next } = makeContext(new Request('https://example.com/'));

    const response = await gate(context);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Test Site');
  });
});

// A window that opens 5 minutes from now - not yet active on its own, but
// should be treated as active once a bufferMinutes safety margin is applied.
const UPCOMING_WINDOW_ITEMS = [
  { title: 'Candle lighting', date: new Date(Date.now() + 5 * 60_000).toISOString(), category: 'candles' },
  { title: 'Havdalah', date: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), category: 'havdalah' },
];

describe('bufferMinutes', () => {
  beforeEach(() => {
    // @ts-expect-error - test-only global stub for the Workers Cache API
    globalThis.caches = { default: fakeCache() };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ items: UPCOMING_WINDOW_ITEMS }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not block before the window when bufferMinutes is omitted', async () => {
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context, next } = makeContext(new Request('https://example.com/'));

    await gate(context);

    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks a few minutes before the window when bufferMinutes is set', async () => {
    const gate = createShabbatGate({ siteName: 'Test Site', bufferMinutes: 10 });
    const { context, next } = makeContext(new Request('https://example.com/'));

    const response = await gate(context);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});

// Routes the fetch mock by which calendar is being requested: the visitor's
// windows are fetched with their own timezone in the URL, Israel's with
// Asia/Jerusalem. Lets a single mock return different windows per calendar.
function routedFetch(byCalendar: { israel: unknown[]; visitor: unknown[] }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const items = url.includes('America') ? byCalendar.visitor : byCalendar.israel;
    return new Response(JSON.stringify({ items }), { status: 200 });
  });
}

function requestWithCf(
  url: string,
  cf: Record<string, unknown> | undefined,
  headers?: Record<string, string>,
): Request {
  const request = new Request(url, headers ? { headers } : undefined);
  if (cf) {
    Object.defineProperty(request, 'cf', { value: cf, configurable: true });
  }
  return request;
}

const NY_CF = { latitude: '40.7128', longitude: '-74.0060', timezone: 'America/New_York', country: 'US' };
const IL_CF = { latitude: '32.0853', longitude: '34.7818', timezone: 'Asia/Jerusalem', country: 'IL' };

describe('enforceVisitorLocation', () => {
  beforeEach(() => {
    // @ts-expect-error - test-only global stub for the Workers Cache API
    globalThis.caches = { default: fakeCache() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks when it's Shabbat where the visitor is, even though it isn't in Israel", async () => {
    routedFetch({ israel: [], visitor: OPEN_WINDOW_ITEMS });

    const gate = createShabbatGate({ siteName: 'Test Site', enforceVisitorLocation: true });
    const { context, next } = makeContext(requestWithCf('https://example.com/', NY_CF));

    const response = await gate(context);

    expect(next).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test Site');
  });

  it("does not consult the visitor's calendar when the flag is off (Israel-only)", async () => {
    routedFetch({ israel: [], visitor: OPEN_WINDOW_ITEMS });

    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context, next } = makeContext(requestWithCf('https://example.com/', NY_CF));

    await gate(context);

    // Israel is outside any window, and the flag is off, so the visitor's open
    // window must be ignored - the request goes through.
    expect(next).toHaveBeenCalledOnce();
  });

  it('falls back to the Israel-only decision when geolocation is unavailable', async () => {
    routedFetch({ israel: [], visitor: OPEN_WINDOW_ITEMS });

    const gate = createShabbatGate({ siteName: 'Test Site', enforceVisitorLocation: true });
    // No `cf` on the request (e.g. local dev): the visitor window is never
    // fetched, so only Israel's (empty) calendar decides -> let through.
    const { context, next } = makeContext(requestWithCf('https://example.com/', undefined));

    await gate(context);

    expect(next).toHaveBeenCalledOnce();
  });

  it("still blocks on Israel's Shabbat even when the visitor's location is clear", async () => {
    routedFetch({ israel: OPEN_WINDOW_ITEMS, visitor: [] });

    const gate = createShabbatGate({ siteName: 'Test Site', enforceVisitorLocation: true });
    const { context, next } = makeContext(requestWithCf('https://example.com/', NY_CF));

    const response = await gate(context);

    expect(next).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test Site');
  });
});

describe('localized secondary message for visitors abroad', () => {
  beforeEach(() => {
    // @ts-expect-error - test-only global stub for the Workers Cache API
    globalThis.caches = { default: fakeCache() };
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ items: OPEN_WINDOW_ITEMS }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends a message in the visitor's browser language when they are abroad", async () => {
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context } = makeContext(requestWithCf('https://example.com/', NY_CF, { 'accept-language': 'fr-FR,fr;q=0.9' }));

    const response = await gate(context);
    const body = await response.text();

    expect(body).toContain('Chabbat'); // the French secondary line
    expect(body).toContain('האתר סגור'); // Hebrew still present, first
  });

  it('does not append a secondary message for a Hebrew-speaking visitor', async () => {
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context } = makeContext(requestWithCf('https://example.com/', NY_CF, { 'accept-language': 'he-IL,he;q=0.9' }));

    const response = await gate(context);
    const body = await response.text();

    expect(body).not.toContain('class="secondary"');
    expect(body).toContain('האתר סגור');
  });

  it('does not append a secondary message for a visitor inside Israel', async () => {
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context } = makeContext(requestWithCf('https://example.com/', IL_CF, { 'accept-language': 'en-US,en;q=0.9' }));

    const response = await gate(context);
    const body = await response.text();

    expect(body).not.toContain('class="secondary"');
  });

  it('renders the Arabic secondary block right-to-left', async () => {
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context } = makeContext(requestWithCf('https://example.com/', NY_CF, { 'accept-language': 'ar,en;q=0.8' }));

    const response = await gate(context);
    const body = await response.text();

    expect(body).toContain('<div class="secondary" dir="rtl">');
    expect(body).toContain('شابات'); // "Shabat" in the Arabic line
  });

  it('falls back to English for an unsupported browser language', async () => {
    const gate = createShabbatGate({ siteName: 'Test Site' });
    const { context } = makeContext(requestWithCf('https://example.com/', NY_CF, { 'accept-language': 'ja-JP,ja;q=0.9' }));

    const response = await gate(context);
    const body = await response.text();

    expect(body).toContain('observance of Shabbat'); // English fallback
  });
});

describe('createShabbatGateForWorker', () => {
  beforeEach(() => {
    // @ts-expect-error - test-only global stub for the Workers Cache API
    globalThis.caches = { default: fakeCache() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null (let the real site through) outside any window', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));

    const gate = createShabbatGateForWorker({ siteName: 'Test Site' });
    const result = await gate(new Request('https://example.com/'));

    expect(result).toBeNull();
  });

  it('returns a holding-page Response when now falls inside an open window', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ items: OPEN_WINDOW_ITEMS }), { status: 200 });
    });

    const gate = createShabbatGateForWorker({ siteName: 'Test Site' });
    const result = await gate(new Request('https://example.com/'));

    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    expect(await result?.text()).toContain('Test Site');
  });

  it('fails open (returns null) when the Hebcal fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const gate = createShabbatGateForWorker({ siteName: 'Test Site' });
    const result = await gate(new Request('https://example.com/'));

    expect(result).toBeNull();
  });
});
