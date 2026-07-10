# shabbat-gate

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
   *  page showing siteName and when the site reopens. */
  renderHoldingPage?: (ctx: { siteName: string; reasonLabel: string; untilLabel: string }) => string;
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
});

export const onRequest: PagesFunction = (context) => gate(context);
```

## How it works

1. Bot check (allowlist regex on the `user-agent` header) - matches pass straight through.
2. Bypass check - if the bypass query param + value match, pass straight through.
3. Fetch (with ~24h caching via the Workers Cache API) the merged list of Shabbat and major
   holiday windows from Hebcal, ~45 days into the future.
4. If the current time falls inside a window, serve the holding page (HTTP 200). Otherwise let
   the real site through.
5. Any error along the way falls through to the real site.

## License

MIT
