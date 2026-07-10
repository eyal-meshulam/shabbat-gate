import { isBot } from './botPattern.js';
import { fetchWindows, findActiveWindow, type Window } from './hebcal.js';
import { defaultRenderHoldingPage, type HoldingPageContext } from './holdingPage.js';

export type { Window } from './hebcal.js';
export type { HoldingPageContext } from './holdingPage.js';
export { isBlocked, findActiveWindow, pairWindows, fetchWindows } from './hebcal.js';
export { isBot, BOT_PATTERN } from './botPattern.js';
export { defaultRenderHoldingPage } from './holdingPage.js';

export interface ShabbatGateConfig {
  siteName: string;
  /** Decimal lat/long for zmanim. Both default to Jerusalem if omitted - a fine
   *  single reference point for all of Israel at this granularity. */
  latitude?: number;
  longitude?: number;
  /** Query param name + required value that bypasses the gate entirely, for
   *  the site owner to preview/test on any day. Keep the value non-guessable -
   *  this is a testing convenience, not real auth. */
  bypassParam?: string;
  bypassValue?: string;
  /** Optional custom holding-page renderer. Defaults to a Hebrew, mobile-
   *  responsive page showing siteName + when the site reopens. */
  renderHoldingPage?: (ctx: HoldingPageContext) => string;
}

const JERUSALEM_LATITUDE = 31.7683;
const JERUSALEM_LONGITUDE = 35.2137;
const CACHE_KEY_URL = 'https://internal.cache/shabbat-gate-windows-v1';
const CACHE_TTL_SECONDS = 24 * 60 * 60;

async function getWindows(latitude: number, longitude: number): Promise<Window[]> {
  const cache = caches.default;
  const cacheRequest = new Request(CACHE_KEY_URL);

  const cached = await cache.match(cacheRequest);
  if (cached) {
    return (await cached.json()) as Window[];
  }

  const windows = await fetchWindows(latitude, longitude);
  const cacheResponse = new Response(JSON.stringify(windows), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(cacheRequest, cacheResponse);
  return windows;
}

function formatJerusalemTime(epochMs: number): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

/**
 * Returns a Cloudflare Pages Functions-compatible handler that closes the
 * site to human visitors during Shabbat and major Jewish holidays, while
 * always letting search engines and AI crawlers through. Fails open on any
 * error - an accidental block on a regular Tuesday is a real, visible bug; an
 * occasional missed block during an error is a minor, invisible one.
 */
export function createShabbatGate(config: ShabbatGateConfig): PagesFunction {
  return async (context) => {
    const { request, next } = context;

    const userAgent = request.headers.get('user-agent') ?? '';
    if (isBot(userAgent)) {
      return next();
    }

    if (config.bypassParam && config.bypassValue) {
      const url = new URL(request.url);
      if (url.searchParams.get(config.bypassParam) === config.bypassValue) {
        return next();
      }
    }

    try {
      const latitude = config.latitude ?? JERUSALEM_LATITUDE;
      const longitude = config.longitude ?? JERUSALEM_LONGITUDE;
      const windows = await getWindows(latitude, longitude);
      const active = findActiveWindow(windows, Date.now());

      if (!active) {
        return next();
      }

      const render = config.renderHoldingPage ?? defaultRenderHoldingPage;
      const html = render({
        siteName: config.siteName,
        reasonLabel: active.label,
        untilLabel: formatJerusalemTime(active.end),
      });

      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    } catch (error) {
      console.error('shabbat-gate: failing open due to error', error);
      return next();
    }
  };
}
