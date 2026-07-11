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
  /** Minutes to close the site *before* candle-lighting and reopen *after*
   *  havdalah, on top of the raw Hebcal window. Defaults to 0 (no buffer).
   *  Useful padding against clock drift / last-minute browsing right at the
   *  boundary - applied at decision time, not baked into the cached windows,
   *  so changing it takes effect immediately without waiting on the cache. */
  bufferMinutes?: number;
}

const JERUSALEM_LATITUDE = 31.7683;
const JERUSALEM_LONGITUDE = 35.2137;

/** Internal cache key for the merged window list (~24h TTL via the Workers
 *  Cache API). Exported so consumers that do their own caching of
 *  derived/post-processed window data (e.g. after applying their own buffer)
 *  can pick a different key and avoid accidentally colliding with this one -
 *  which would silently serve stale, unprocessed windows for up to 24h. */
export const INTERNAL_CACHE_KEY_URL = 'https://internal.cache/shabbat-gate-windows-v1';
const CACHE_TTL_SECONDS = 24 * 60 * 60;

async function getWindows(latitude: number, longitude: number): Promise<Window[]> {
  const cache = caches.default;
  const cacheRequest = new Request(INTERNAL_CACHE_KEY_URL);

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

function applyBuffer(windows: Window[], bufferMinutes: number): Window[] {
  if (!bufferMinutes) {
    return windows;
  }
  const bufferMs = bufferMinutes * 60_000;
  return windows.map((w) => ({ ...w, start: w.start - bufferMs, end: w.end + bufferMs }));
}

/** `'pass'` = let the real site through. `'block'` = serve `html` instead. */
type GateDecision = { type: 'pass' } | { type: 'block'; html: string };

/**
 * Shared core: bot allowlist, bypass check, window fetch (cached) + buffer,
 * and the fail-open try/catch. Both `createShabbatGate` (Pages Functions) and
 * `createShabbatGateForWorker` (plain Workers + Assets) are thin wrappers
 * around this, so neither can drift out of sync on caching/fail-open/bypass
 * behavior.
 */
async function evaluateGate(config: ShabbatGateConfig, request: Request): Promise<GateDecision> {
  const userAgent = request.headers.get('user-agent') ?? '';
  if (isBot(userAgent)) {
    return { type: 'pass' };
  }

  if (config.bypassParam && config.bypassValue) {
    const url = new URL(request.url);
    if (url.searchParams.get(config.bypassParam) === config.bypassValue) {
      return { type: 'pass' };
    }
  }

  try {
    const latitude = config.latitude ?? JERUSALEM_LATITUDE;
    const longitude = config.longitude ?? JERUSALEM_LONGITUDE;
    const windows = applyBuffer(await getWindows(latitude, longitude), config.bufferMinutes ?? 0);
    const active = findActiveWindow(windows, Date.now());

    if (!active) {
      return { type: 'pass' };
    }

    const render = config.renderHoldingPage ?? defaultRenderHoldingPage;
    const html = render({
      siteName: config.siteName,
      reasonLabel: active.label,
      closingLabel: active.closingLabel,
      untilLabel: formatJerusalemTime(active.end),
    });

    return { type: 'block', html };
  } catch (error) {
    console.error('shabbat-gate: failing open due to error', error);
    return { type: 'pass' };
  }
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
    const decision = await evaluateGate(config, context.request);
    if (decision.type === 'pass') {
      return context.next();
    }
    return new Response(decision.html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
}

/**
 * Same gate logic as `createShabbatGate`, adapted for a plain Cloudflare
 * Worker (with a static `assets` binding) instead of Pages Functions - there
 * is no `next()` to call in that shape, so this returns `null` for "let the
 * real site through" and a `Response` for "serve the holding page". Wire it
 * up in the Worker's own `fetch` handler:
 *
 *   const gate = createShabbatGateForWorker({ siteName: 'My Site' });
 *   export default {
 *     async fetch(request, env, ctx) {
 *       const blocked = await gate(request);
 *       return blocked ?? env.ASSETS.fetch(request);
 *     },
 *   };
 *
 * Note: a Worker with an `assets` binding skips the `fetch` handler entirely
 * for requests matching a static asset unless `assets.run_worker_first: true`
 * is set in `wrangler.jsonc` - without it, this gate never runs.
 */
export function createShabbatGateForWorker(
  config: ShabbatGateConfig,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const decision = await evaluateGate(config, request);
    if (decision.type === 'pass') {
      return null;
    }
    return new Response(decision.html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
}
