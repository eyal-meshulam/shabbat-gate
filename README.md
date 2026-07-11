# shabbat-gate

[קריאה בעברית](README.he.md)

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
   *  omitted - a fine single reference point for all of Israel at this granularity. */
  latitude?: number;
  longitude?: number;

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
  }) => string;

  /** Minutes to close the site *before* candle-lighting and reopen *after*
   *  havdalah, on top of the raw Hebcal window. Defaults to 0. Useful padding
   *  against clock drift / last-minute browsing right at the boundary. */
  bufferMinutes?: number;
}
```

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
5. If the current time falls inside a window, serve the holding page (HTTP 200). Otherwise let
   the real site through.
6. Any error along the way falls through to the real site.

## Internal cache key

The merged window list is cached under a fixed internal key
(`https://internal.cache/shabbat-gate-windows-v1`, exported as `INTERNAL_CACHE_KEY_URL`) for
~24h via the Workers Cache API. If your own code also caches derived data (e.g. windows with
your own buffer applied) via `caches.default`, use a different key - reusing this one will
silently serve stale, unprocessed data for up to 24h.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release, including root-cause
explanations for fixed bugs.

## License

MIT
