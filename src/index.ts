import { isBot } from './botPattern.js';
import { fetchWindows, findActiveWindow, mergeWindows, SHABBAT_LABEL, type Window } from './hebcal.js';
import { defaultRenderHoldingPage, type HoldingPageContext } from './holdingPage.js';
import { buildSecondaryMessage, resolveVisitorLanguage } from './translations.js';

export type { Window, FetchWindowsOptions } from './hebcal.js';
export type { HoldingPageContext, SecondaryMessage } from './holdingPage.js';
export type { SupportedLanguage } from './translations.js';
export { isBlocked, findActiveWindow, mergeWindows, pairWindows, fetchWindows } from './hebcal.js';
export { SUPPORTED_LANGUAGES, resolveVisitorLanguage } from './translations.js';
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
  /** When `true`, also block a visitor during Shabbat/Yom Tov in *their own*
   *  location (derived from Cloudflare's `request.cf` geolocation), not only
   *  during Israel's. The site is then closed to them if it's Shabbat in Israel
   *  *or* where they are - so an overseas visitor stays blocked from Israel's
   *  candle-lighting right through their own local havdalah. Holidays for a
   *  visitor outside Israel use diaspora two-day Yom Tov reckoning. Defaults to
   *  `false` (Israel-only gate, the original behavior). If geolocation is
   *  unavailable for a request (e.g. local `wrangler dev`, or an IP Cloudflare
   *  can't place), that request falls back to the Israel-only decision. */
  enforceVisitorLocation?: boolean;
}

const JERUSALEM_LATITUDE = 31.7683;
const JERUSALEM_LONGITUDE = 35.2137;

/** Internal cache key for the merged window list (~24h TTL via the Workers
 *  Cache API). Exported so consumers that do their own caching of
 *  derived/post-processed window data (e.g. after applying their own buffer)
 *  can pick a different key and avoid accidentally colliding with this one -
 *  which would silently serve stale, unprocessed windows for up to 24h. */
export const INTERNAL_CACHE_KEY_URL = 'https://internal.cache/shabbat-gate-windows-v1';
/** Cache-key prefix for per-visitor-location window lists. Keyed by rounded
 *  coordinates + timezone + reckoning so all visitors within ~1° of each other
 *  share one cached fetch (sunset differs by only a few minutes across a cell -
 *  immaterial at "block the whole site or not" granularity). */
const VISITOR_CACHE_KEY_PREFIX = 'https://internal.cache/shabbat-gate-visitor-v1';
const CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Fetch a window list through the Workers Cache API under a fixed key. */
async function getCachedWindows(cacheKeyUrl: string, fetcher: () => Promise<Window[]>): Promise<Window[]> {
  const cache = caches.default;
  const cacheRequest = new Request(cacheKeyUrl);

  const cached = await cache.match(cacheRequest);
  if (cached) {
    return (await cached.json()) as Window[];
  }

  const windows = await fetcher();
  const cacheResponse = new Response(JSON.stringify(windows), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(cacheRequest, cacheResponse);
  return windows;
}

interface VisitorLocation {
  latitude: number;
  longitude: number;
  tzid: string;
  israelMode: boolean;
}

/** Reads the visitor's geolocation from Cloudflare's `request.cf`. Returns
 *  `null` when any needed field is missing/unparseable (local dev, an IP CF
 *  can't place) so callers can fall back to the Israel-only decision. A visitor
 *  physically in Israel gets Israel single-day reckoning; everyone else gets
 *  diaspora two-day Yom Tov. */
function readVisitorLocation(request: Request): VisitorLocation | null {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
  if (!cf) {
    return null;
  }

  const latitude = Number(cf.latitude);
  const longitude = Number(cf.longitude);
  const tzid = typeof cf.timezone === 'string' ? cf.timezone : '';

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !tzid) {
    return null;
  }

  return { latitude, longitude, tzid, israelMode: cf.country === 'IL' };
}

/** Israel/Jerusalem windows - the base gate, always computed. */
function getIsraelWindows(latitude: number, longitude: number): Promise<Window[]> {
  return getCachedWindows(INTERNAL_CACHE_KEY_URL, () => fetchWindows(latitude, longitude));
}

/** Windows for a specific visitor location, cached per rounded cell. */
function getVisitorWindows(loc: VisitorLocation): Promise<Window[]> {
  const rlat = Math.round(loc.latitude);
  const rlon = Math.round(loc.longitude);
  const iParam = loc.israelMode ? 'on' : 'off';
  const cacheKey = `${VISITOR_CACHE_KEY_PREFIX}?lat=${rlat}&lon=${rlon}&tz=${encodeURIComponent(loc.tzid)}&i=${iParam}`;
  return getCachedWindows(cacheKey, () =>
    fetchWindows(loc.latitude, loc.longitude, { israelMode: loc.israelMode, tzid: loc.tzid }),
  );
}

function formatTime(epochMs: number, tzid: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: tzid,
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
    const bufferMinutes = config.bufferMinutes ?? 0;

    // Read the visitor's location once - it drives both the optional extra
    // enforcement (their local Shabbat windows) and the localized message /
    // local-time display shown to a visitor outside Israel.
    const visitor = readVisitorLocation(request);
    const isAbroad = visitor !== null && !visitor.israelMode;

    let windows = applyBuffer(await getIsraelWindows(latitude, longitude), bufferMinutes);

    if (config.enforceVisitorLocation && visitor) {
      const visitorWindows = applyBuffer(await getVisitorWindows(visitor), bufferMinutes);
      // Union of both calendars: block if it's Shabbat/Yom Tov in Israel OR
      // where the visitor is. Merge coalesces the overlap into one continuous
      // block so the shown reopen time is the true end of both.
      windows = mergeWindows([...windows, ...visitorWindows]);
    }

    const active = findActiveWindow(windows, Date.now());

    if (!active) {
      return { type: 'pass' };
    }

    // For a visitor abroad, show times in their own timezone (that's who is
    // looking at the page) and append a message in their browser language.
    const displayTzid = isAbroad ? visitor!.tzid : 'Asia/Jerusalem';
    const untilLabel = formatTime(active.end, displayTzid);

    let secondary: HoldingPageContext['secondary'];
    if (isAbroad) {
      const language = resolveVisitorLanguage(request.headers.get('accept-language') ?? '');
      if (language !== 'he') {
        secondary = buildSecondaryMessage(language, active.label === SHABBAT_LABEL, untilLabel);
      }
    }

    const render = config.renderHoldingPage ?? defaultRenderHoldingPage;
    const html = render({
      siteName: config.siteName,
      reasonLabel: active.label,
      closingLabel: active.closingLabel,
      untilLabel,
      secondary,
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
