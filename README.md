# shabbat-gate

[קריאה בעברית](https://github.com/eyal-meshulam/shabbat-gate/blob/master/README.he.md)

Cloudflare Pages / Workers middleware that automatically closes a site to human visitors
during Shabbat and major Jewish holidays (Israel-observance rules) - while always letting
search engines and AI crawlers through, so SEO stays unaffected.

## Why

- **Israel single-day Yom Tov, not diaspora 2-day.** The holiday calendar is fetched from
  Hebcal's free public API with `i=on`, which is critical - without it you'd get the diaspora
  reckoning (an extra blocked day) instead of the correct single-day Yom Tov used in Israel.
- **Bots always get through.** A broad, case-insensitive user-agent allowlist (Googlebot,
  Bingbot, GPTBot, ClaudeBot, and many others) is checked first, before any other logic runs.
  The gate only ever affects human visitors - crawlers and indexers see the real site 24/7, so
  ranking and AI-search visibility are never impacted by the site being "closed."
- **Fails open.** Any error (network failure, bad API response, whatever) falls through to the
  real site rather than showing an error page. An accidental block on a regular Tuesday would be
  a real, visible bug; an occasional missed block during a rare error is a minor, invisible one.

## Install

```sh
npm install shabbat-gate
```

## Usage

In a Cloudflare Pages project, add `functions/_middleware.ts`:

```ts
import { createShabbatGate } from 'shabbat-gate';

const gate = createShabbatGate({ siteName: 'My Site' });

export const onRequest: PagesFunction = (context) => gate(context);
```

### When the site already has a `functions/_middleware`

Cloudflare Pages runs **only one** middleware file at the root of `functions/`. If two exist
(`_middleware.js` **and** `_middleware.ts`), Cloudflare silently picks one and the other never
runs - no error, no warning. So **do not add a second file**. `gate` calls `context.next()`
itself, which means it is already a composable middleware primitive: export the root
`onRequest` as an **array** of handlers and Cloudflare runs them in order, each calling
`next()`. For example, chaining a preview-noindex guard before the gate:

```js
import { createShabbatGate } from 'shabbat-gate';

const PROD_HOSTS = new Set(['example.com', 'www.example.com']);

const noindex = async ({ request, next }) => {
  const res = await next();
  if (PROD_HOSTS.has(new URL(request.url).hostname)) return res;
  const tagged = new Response(res.body, res);
  tagged.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return tagged;
};

const gate = createShabbatGate({ siteName: 'My Site' });

export const onRequest = [noindex, (context) => gate(context)];
```

No manual `next()` wrapping is needed - the gate participates in the chain as-is.

### Using with a plain Worker + Assets binding (not Pages)

`createShabbatGate` returns a Pages-Functions-shaped handler (`(context) => Response`), which
doesn't fit a plain Worker's `fetch(request, env)` signature (there's no `next()`). Use
`createShabbatGateForWorker` instead - it returns `null` for "let the real site through" and a
`Response` for "serve the holding page":

```ts
import { createShabbatGateForWorker } from 'shabbat-gate';

const gate = createShabbatGateForWorker({ siteName: 'My Site' });

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }) {
    const blocked = await gate(request);
    return blocked ?? env.ASSETS.fetch(request);
  },
};
```

**Gotcha that silently defeats the whole gate:** a Cloudflare Worker with an `assets` binding
serves any request matching a file in the assets directory *directly*, without invoking the
Worker's `fetch` handler at all - unless `run_worker_first: true` is set. Without it, the gate
code runs and looks correctly wired up, tests pass, but real page requests (which almost always
match a static asset) never reach it, so the site never actually closes. In `wrangler.jsonc`:

```jsonc
{
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": true
  }
}
```

## Config

```ts
export interface ShabbatGateConfig {
  siteName: string;

  /** Decimal lat/long for zmanim. Both default to Jerusalem (31.7683, 35.2137) if
   *  omitted - a fine single reference point for all of Israel at this granularity.
   *  Ignored when `geonameid` is set. */
  latitude?: number;
  longitude?: number;

  /** Hebcal geonameid of the site's home city. When set, the base Shabbat/holiday times use
   *  Hebcal's *official* times for that city instead of sunset-minus-default at raw coordinates
   *  (they can differ - e.g. Haifa `294801` lights ~10 min earlier than its bare lat/long).
   *  `latitude`/`longitude` are ignored when set. Does not affect `enforceVisitorLocation`.
   *  Jerusalem=281184, Haifa=294801, Tel Aviv=293397, Beer Sheva=295530. */
  geonameid?: number;

  /** Query param name + required value that bypasses the gate entirely, so the site
   *  owner can preview/test on any day. Keep the value non-guessable - this is a
   *  testing convenience, not real auth. */
  bypassParam?: string;
  bypassValue?: string;

  /** Optional custom holding-page renderer. Defaults to a Hebrew, mobile-responsive
   *  page showing siteName and when the site reopens. `reasonLabel` and `closingLabel`
   *  differ grammatically for plain Shabbat ("שבת קודש" opening vs. "השבת" closing) -
   *  use `closingLabel` for "back after ___", not `reasonLabel` again. */
  renderHoldingPage?: (ctx: {
    siteName: string;
    reasonLabel: string;
    closingLabel: string;
    untilLabel: string;
    /** Optional localized message shown below the Hebrew one (with a blank-line
     *  gap), for a visitor outside Israel, in their own browser language. Absent
     *  for visitors in Israel, Hebrew-speaking visitors, or unknown location. */
    secondary?: { dir: 'ltr' | 'rtl'; lines: string[] };
  }) => string;

  /** Minutes to close the site *before* candle-lighting and reopen *after*
   *  havdalah, on top of the raw Hebcal window. Defaults to 0. Useful padding
   *  against clock drift / last-minute browsing right at the boundary. */
  bufferMinutes?: number;

  /** When `true`, also block a visitor during Shabbat/Yom Tov in *their own*
   *  location (from Cloudflare's `request.cf` geolocation), not only Israel's.
   *  Closed to them if it's Shabbat in Israel *or* where they are - so an
   *  overseas visitor stays blocked from Israel's candle-lighting through their
   *  own local havdalah. Holidays for a visitor outside Israel use diaspora
   *  two-day Yom Tov reckoning. Defaults to `false` (Israel-only). Falls back to
   *  the Israel-only decision when a request has no geolocation (local dev,
   *  unplaceable IP). */
  enforceVisitorLocation?: boolean;
}
```

### Blocking by the visitor's timezone too (`enforceVisitorLocation`)

By default the gate uses **Israel's** calendar for every visitor worldwide: the moment
Shabbat ends in Israel, the site reopens for everyone - including a US visitor for whom it's
still Shabbat. Set `enforceVisitorLocation: true` to make it the **union of two Shabbatot**:
the site is closed to a visitor if it's Shabbat/Yom Tov in Israel **or** where they are. A New
York visitor is then blocked from Israel's candle-lighting (even if it's still Friday afternoon
for them) continuously through their own local havdalah. Holidays are reckoned diaspora-style
(two-day Yom Tov) for visitors abroad. Chanukah, Purim, Yom HaAtzma'ut and Chol HaMoed never
block, in Israel or abroad.

### Localized message for visitors abroad

When a visitor is outside Israel, the default holding page shows the Hebrew message first,
then (below a two-line gap) a message in their browser language (from `Accept-Language`).
Built-in languages: English (default/fallback), French, Russian, Spanish, German, and Arabic
(rendered right-to-left). Hebrew speakers and visitors in Israel get no second message; the
reopen time is shown in the visitor's own timezone. This works even without `enforceVisitorLocation` (whenever the site is
closed and the visitor is known to be abroad).

Full example:

```ts
import { createShabbatGate } from 'shabbat-gate';

const gate = createShabbatGate({
  siteName: 'tehila·games',
  latitude: 31.7683,
  longitude: 35.2137,
  bypassParam: 'preview',
  bypassValue: 'letmein-9f3a7c',
  bufferMinutes: 10,
});

export const onRequest: PagesFunction = (context) => gate(context);
```

## How it works

1. Bot check (allowlist regex on the `user-agent` header) - matches pass straight through.
2. Bypass check - if the bypass query param + value match, pass straight through.
3. Fetch (with ~24h caching via the Workers Cache API) the merged list of Shabbat and major
   holiday windows from Hebcal, ~45 days into the future - one call to Hebcal's `/hebcal`
   endpoint (`ss=on` for weekly Shabbat + `maj=on` for major holidays), passing `latitude`/
   `longitude` directly so every window is correctly localized, not just the nearest one.
4. `bufferMinutes` (if set) is applied on top of the fetched windows before the time check.
5. If `enforceVisitorLocation` is set, a second window list is fetched for the visitor's own
   location (from `request.cf`, diaspora reckoning when abroad) and unioned with Israel's -
   blocking if the time falls inside either. Overlapping windows are coalesced into one
   continuous window so the shown reopen time is accurate.
6. If the current time falls inside a window, serve the holding page (HTTP 200). Otherwise let
   the real site through.
7. Any error along the way falls through to the real site.

## Internal cache key

The merged window list is cached under a fixed internal key
(`https://internal.cache/shabbat-gate-windows-v1`, exported as `INTERNAL_CACHE_KEY_URL`) for
~24h via the Workers Cache API. If your own code also caches derived data (e.g. windows with
your own buffer applied) via `caches.default`, use a different key - reusing this one will
silently serve stale, unprocessed data for up to 24h.

## Changelog

See [CHANGELOG.md](https://github.com/eyal-meshulam/shabbat-gate/blob/master/CHANGELOG.md) for what changed in each release, including root-cause
explanations for fixed bugs.

## License

MIT
