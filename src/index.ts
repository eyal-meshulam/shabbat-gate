import { isBot } from './botPattern.js';
import { fetchWindows, findActiveWindow, mergeWindows, SHABBAT_LABEL, type Window } from './hebcal.js';
import { defaultRenderHoldingPage, type HoldingPageContext } from './holdingPage.js';
import { buildSecondaryMessage, resolveVisitorLanguage } from './translations.js';

export type { Window, FetchWindowsOptions } from './hebcal.js';
export type { HoldingPageContext, SecondaryMessage } from './holdingPage.js';
export type { SupportedLanguage } from './translations.js';
export {
  isBlocked,
  findActiveWindow,
  mergeWindows,
  pairWindows,
  fetchWindows,
  HebcalTimeoutError,
  DEFAULT_HEBCAL_TIMEOUT_MS,
} from './hebcal.js';
export { SUPPORTED_LANGUAGES, resolveVisitorLanguage } from './translations.js';
export { isBot, BOT_PATTERN } from './botPattern.js';
export { defaultRenderHoldingPage } from './holdingPage.js';

export interface ShabbatGateConfig {
  siteName: string;
  /** Decimal lat/long for zmanim. Both default to Jerusalem if omitted - a fine
   *  single reference point for all of Israel at this granularity. Ignored when
   *  `geonameid` is set. */
  latitude?: number;
  longitude?: number;
  /** Hebcal geonameid of the site's home city. When set, the site's own
   *  Shabbat/holiday times come from Hebcal's *official* times for that city
   *  (rather than sunset-minus-default at raw coordinates), and `latitude`/
   *  `longitude` are ignored for the base window. Preferred over lat/long when
   *  you want a specific Israeli city exactly - e.g. Haifa (`294801`) lights
   *  ~10 min earlier than its bare coordinates. Jerusalem=281184, Haifa=294801,
   *  Tel Aviv=293397, Beer Sheva=295530. Does not affect `enforceVisitorLocation`
   *  (visitor windows always come from the visitor's `request.cf` coordinates). */
  geonameid?: number;
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
  /** How long to wait for Hebcal before giving up and failing open (default
   *  3000ms). Only ever paid on a cold cache - once warm, an expired window
   *  list is served immediately and refreshed in the background, so this
   *  timeout never lands on a visitor's request. Raise it only if you'd rather
   *  a cold visitor wait than risk a missed block. */
  hebcalTimeoutMs?: number;
}

const JERUSALEM_LATITUDE = 31.7683;
const JERUSALEM_LONGITUDE = 35.2137;

/** Internal cache key for the merged window list (~24h TTL via the Workers
 *  Cache API). Exported so consumers that do their own caching of
 *  derived/post-processed window data (e.g. after applying their own buffer)
 *  can pick a different key and avoid accidentally colliding with this one -
 *  which would silently serve stale, unprocessed windows for up to 24h. */
export const INTERNAL_CACHE_KEY_URL = 'https://internal.cache/shabbat-gate-windows-v2';
/** Cache-key prefix for per-visitor-location window lists. Keyed by rounded
 *  coordinates + timezone + reckoning so all visitors within ~1° of each other
 *  share one cached fetch (sunset differs by only a few minutes across a cell -
 *  immaterial at "block the whole site or not" granularity). */
const VISITOR_CACHE_KEY_PREFIX = 'https://internal.cache/shabbat-gate-visitor-v2';
/** How long a cached window list counts as fresh. Past this it is still served
 *  (see stale-while-revalidate below) while a refresh runs out of band. */
const CACHE_TTL_SECONDS = 24 * 60 * 60;
/** How long a *stale* list may still be served. Windows are fetched 45 days
 *  ahead, so a week-old list is still correct for the next ~38 days - serving
 *  it is strictly better than making a visitor wait on a slow upstream. Also
 *  the Cache API `max-age`, so anything older stops matching entirely and the
 *  next request refetches synchronously. */
const CACHE_MAX_STALE_SECONDS = 7 * 24 * 60 * 60;
/** After a failed or timed-out fetch, don't try again for this long. Without
 *  it, every concurrent visitor starts their own request against an upstream
 *  that is already struggling - the thundering herd that turned one slow
 *  Hebcal response into a cluster of 504s in production on 2026-07-28. */
const CACHE_FAILURE_TTL_SECONDS = 60;

/** What actually goes in the cache: the windows plus when they were fetched
 *  (freshness is decided here, not by the Cache API, precisely so an expired
 *  entry can still be *served* while it refreshes) and when the last attempt
 *  failed. `windows: null` = we have nothing usable, only a remembered
 *  failure. */
interface WindowCacheRecord {
  windows: Window[] | null;
  fetchedAt: number;
  failedAt?: number;
}

/** In-flight fetches per cache key, deduped within this isolate. The Cache API
 *  only helps once a fetch has *finished*; on a cold start every concurrent
 *  request would otherwise open its own connection. */
const inFlightFetches = new Map<string, Promise<Window[]>>();

async function readCacheRecord(cacheKeyUrl: string): Promise<WindowCacheRecord | null> {
  try {
    const cached = await caches.default.match(new Request(cacheKeyUrl));
    if (!cached) {
      return null;
    }
    const body = (await cached.json()) as Partial<WindowCacheRecord> | null;
    if (!body || typeof body !== 'object' || !('fetchedAt' in body)) {
      return null;
    }
    return {
      windows: Array.isArray(body.windows) ? body.windows : null,
      fetchedAt: typeof body.fetchedAt === 'number' ? body.fetchedAt : 0,
      failedAt: typeof body.failedAt === 'number' ? body.failedAt : undefined,
    };
  } catch {
    // A corrupt/unreadable entry must not take the site down - treat it as a
    // miss and refetch.
    return null;
  }
}

async function writeCacheRecord(cacheKeyUrl: string, record: WindowCacheRecord): Promise<void> {
  // A record with no usable windows is only a "don't retry yet" marker, so it
  // must expire quickly; a real list should outlive its freshness window so it
  // can still be served stale.
  const maxAge = record.windows ? CACHE_MAX_STALE_SECONDS : CACHE_FAILURE_TTL_SECONDS;
  await caches.default.put(
    new Request(cacheKeyUrl),
    new Response(JSON.stringify(record), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${maxAge}`,
      },
    }),
  );
}

/** Runs (or joins) the single in-flight fetch for this key and records the
 *  outcome - success or failure - in the cache. Rejects on failure; callers
 *  decide whether that's fatal (cold start -> fail open) or ignorable
 *  (background refresh -> keep serving stale). */
function refreshWindows(
  cacheKeyUrl: string,
  fetcher: () => Promise<Window[]>,
  existing: WindowCacheRecord | null,
): Promise<Window[]> {
  const pending = inFlightFetches.get(cacheKeyUrl);
  if (pending) {
    return pending;
  }

  const attempt = (async () => {
    let windows: Window[];
    try {
      windows = await fetcher();
    } catch (error) {
      // Remember the failure so the next visitors don't pile onto a struggling
      // upstream - but never discard windows we already have. Recording it is
      // best-effort; if even that fails, the original error is what matters.
      await writeCacheRecord(cacheKeyUrl, {
        windows: existing?.windows ?? null,
        fetchedAt: existing?.fetchedAt ?? 0,
        failedAt: Date.now(),
      }).catch(() => undefined);
      throw error;
    }

    // Caching is an optimization, not a precondition: a cache write that fails
    // must not throw away windows we successfully fetched.
    await writeCacheRecord(cacheKeyUrl, { windows, fetchedAt: Date.now() }).catch((error) => {
      console.error('shabbat-gate: could not cache windows', error);
    });
    return windows;
  })();

  inFlightFetches.set(cacheKeyUrl, attempt);
  return attempt.finally(() => {
    inFlightFetches.delete(cacheKeyUrl);
  });
}

function failedRecently(record: WindowCacheRecord | null, now: number): boolean {
  return record?.failedAt != null && now - record.failedAt < CACHE_FAILURE_TTL_SECONDS * 1000;
}

/**
 * Fetch a window list through the Workers Cache API under a fixed key, with
 * stale-while-revalidate: a visitor only ever waits on Hebcal when there is
 * nothing usable cached at all. Once warm, an expired list is served
 * immediately and refreshed in the background via `waitUntil`, so a slow
 * upstream can never sit on a visitor's request.
 */
async function getCachedWindows(
  cacheKeyUrl: string,
  fetcher: () => Promise<Window[]>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Window[]> {
  const record = await readCacheRecord(cacheKeyUrl);
  const now = Date.now();

  if (record?.windows) {
    if (now - record.fetchedAt < CACHE_TTL_SECONDS * 1000) {
      return record.windows;
    }

    // Stale but usable: hand it back now, refresh out of band. Everything here
    // is best-effort - a refresh that can't even be scheduled must not cost
    // this visitor the perfectly good windows we're already holding.
    if (!failedRecently(record, now)) {
      const refreshing = refreshWindows(cacheKeyUrl, fetcher, record).catch((error) => {
        console.error('shabbat-gate: background window refresh failed', error);
      });
      try {
        waitUntil?.(refreshing);
      } catch (error) {
        console.error('shabbat-gate: could not schedule background refresh', error);
      }
    }
    return record.windows;
  }

  // Nothing usable cached. If an attempt just failed, fail open right away
  // rather than making this visitor wait on an upstream we know is unhealthy.
  if (failedRecently(record, now)) {
    throw new Error('shabbat-gate: skipping hebcal retry, a recent fetch failed');
  }

  return refreshWindows(cacheKeyUrl, fetcher, record);
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

/** Israel windows - the base gate, always computed. When `geonameid` is set the
 *  site's own times come from Hebcal's official city times (and the cache key is
 *  namespaced by it so switching location doesn't serve stale coordinate-based
 *  windows for up to 24h). */
function getIsraelWindows(
  latitude: number,
  longitude: number,
  geonameid: number | undefined,
  timeoutMs: number | undefined,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Window[]> {
  const cacheKey =
    geonameid != null ? `${INTERNAL_CACHE_KEY_URL}?geonameid=${geonameid}` : INTERNAL_CACHE_KEY_URL;
  return getCachedWindows(
    cacheKey,
    () => fetchWindows(latitude, longitude, { ...(geonameid != null ? { geonameid } : {}), timeoutMs }),
    waitUntil,
  );
}

/** Windows for a specific visitor location, cached per rounded cell. */
function getVisitorWindows(
  loc: VisitorLocation,
  timeoutMs: number | undefined,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Window[]> {
  const rlat = Math.round(loc.latitude);
  const rlon = Math.round(loc.longitude);
  const iParam = loc.israelMode ? 'on' : 'off';
  const cacheKey = `${VISITOR_CACHE_KEY_PREFIX}?lat=${rlat}&lon=${rlon}&tz=${encodeURIComponent(loc.tzid)}&i=${iParam}`;
  return getCachedWindows(
    cacheKey,
    () => fetchWindows(loc.latitude, loc.longitude, { israelMode: loc.israelMode, tzid: loc.tzid, timeoutMs }),
    waitUntil,
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
async function evaluateGate(
  config: ShabbatGateConfig,
  request: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<GateDecision> {
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

    let windows = applyBuffer(
      await getIsraelWindows(latitude, longitude, config.geonameid, config.hebcalTimeoutMs, waitUntil),
      bufferMinutes,
    );

    if (config.enforceVisitorLocation && visitor) {
      const visitorWindows = applyBuffer(
        await getVisitorWindows(visitor, config.hebcalTimeoutMs, waitUntil),
        bufferMinutes,
      );
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
    const decision = await evaluateGate(config, context.request, (promise) => context.waitUntil(promise));
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
 *       const blocked = await gate(request, ctx);
 *       return blocked ?? env.ASSETS.fetch(request);
 *     },
 *   };
 *
 * Passing `ctx` is optional but recommended: it's what lets a stale window
 * list refresh in the background after the response is sent, instead of the
 * refresh being cancelled when the invocation ends.
 *
 * Note: a Worker with an `assets` binding skips the `fetch` handler entirely
 * for requests matching a static asset unless `assets.run_worker_first: true`
 * is set in `wrangler.jsonc` - without it, this gate never runs.
 */
export function createShabbatGateForWorker(
  config: ShabbatGateConfig,
): (request: Request, ctx?: { waitUntil(promise: Promise<unknown>): void }) => Promise<Response | null> {
  return async (request, ctx) => {
    const decision = await evaluateGate(config, request, ctx ? (p) => ctx.waitUntil(p) : undefined);
    if (decision.type === 'pass') {
      return null;
    }
    return new Response(decision.html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
}
