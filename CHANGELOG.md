# Changelog

All notable changes to this package are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] - Unreleased

### Fixed

- **A *slow* Hebcal took a consumer's site down with 504s - the exact opposite of this
  package's fail-open design.** Found in production on 2026-07-28 on `primestack.co.il`: 24h of
  Cloudflare zone analytics showed 14 homepage `504`s, clustered in the same hours as 53 `504`s
  on the internal cache key `/shabbat-gate-windows-v1`. Nothing else on the site 504'd.

  Root cause: `fetchWindows` did a plain `await fetch(url)` with no timeout and no
  `AbortSignal`. The gate wraps everything in a `try/catch` that fails open - **but a
  `try/catch` only rescues a rejection, never a hang.** When Hebcal was slow rather than down,
  the fetch never settled, the Worker invocation ran past its limit, and Cloudflare returned
  504 to the visitor; the catch never ran, so "fail open" never happened. And because it was a
  cache miss, *every* concurrent visitor started their own fetch - a thundering herd, which is
  why the 504s arrived in clusters rather than one at a time.

  Four changes, so that a slow or broken upstream can never again reach the visitor:
  - **`fetchWindows` now aborts** via `AbortController` after `timeoutMs` (new
    `FetchWindowsOptions` field, default 3000; exported as `DEFAULT_HEBCAL_TIMEOUT_MS`),
    rejecting with a distinct `HebcalTimeoutError` so the failure mode is greppable in logs. A
    real abort rather than a `Promise.race`, which would leave the underlying request dangling.
    The signal stays armed across `res.json()` too - a stalled body stream hangs an invocation
    just as effectively as a stalled connection.
  - **Stale-while-revalidate.** A cached window list is now served past its 24h freshness
    window (up to 7 days) while it refreshes in the background via `waitUntil`, so once the
    cache is warm no visitor ever waits on Hebcal at all. Windows are fetched 45 days ahead, so
    a week-old list is still correct for the next ~38 days.
  - **Failures are cached for 60s**, so a struggling upstream gets one retry per minute instead
    of one per visitor.
  - **Concurrent fetches are deduped** per cache key within an isolate, closing the cold-start
    herd the Cache API alone can't (it only helps once a fetch has *finished*).

  Regression tests stub `fetch` with a promise that never resolves and assert the gate returns
  the real site rather than hanging - both tests hang and fail against the old code.

### Added

- `ShabbatGateConfig.hebcalTimeoutMs` (default 3000) - how long to wait for Hebcal before
  giving up and failing open. Only ever paid on a cold cache.
- `createShabbatGateForWorker`'s handler now takes an optional second argument, the Worker's
  `ctx`: `gate(request, ctx)`. Passing it lets a stale window list refresh *after* the response
  is sent instead of the refresh being cancelled when the invocation ends. Backward compatible -
  existing `gate(request)` calls keep working, they just lose background revalidation.
  `createShabbatGate` (Pages) wires this up automatically from its own `context`.

### Changed

- **The internal cache key moved to `...-windows-v2`** (and `...-visitor-v2`), because cache
  entries now carry their fetch timestamp and failure state rather than being a bare window
  array. Consumers reading `INTERNAL_CACHE_KEY_URL` are unaffected; anyone who hardcoded the
  `v1` string will now be reading a key nothing writes to.

## [0.3.1] - Unreleased (never published separately; folded into 0.4.0)

### Documentation

- Documented middleware **chaining** for Cloudflare Pages sites that already have a root
  `functions/_middleware`. Cloudflare runs only one root middleware file - two (`_middleware.js`
  **and** `_middleware.ts`) means one is silently ignored. Since `gate` already calls
  `context.next()`, it composes as-is: export the root `onRequest` as an array
  (`export const onRequest = [noindex, (context) => gate(context)]`) and Cloudflare runs them in
  order. No code change - the gate was already a composable middleware primitive; this just adds
  the README section (both languages) so consumers don't add a clashing second file. Found live
  installing on eyalmeshulam.com (which already had a preview-noindex middleware).

## [0.3.0] - 2026-07-19

### Added

- `ShabbatGateConfig.geonameid` (and `FetchWindowsOptions.geonameid`) - set the site's home city
  by Hebcal geonameid instead of `latitude`/`longitude`, so the base Shabbat/holiday times come
  out at Hebcal's *official* times for that city. This matters because a city's official
  candle-lighting can differ from a raw sunset-minus-default computation at the same coordinates:
  e.g. Haifa (`294801`) lights ~10 minutes earlier than its bare lat/long - a real gap for a
  Shabbat-observant site owner. When set, `latitude`/`longitude` are ignored for the base window
  (and the internal cache key is namespaced by the geonameid so switching location doesn't serve
  stale coordinate-based windows). Does not affect `enforceVisitorLocation` - visitor windows
  always come from the visitor's `request.cf` coordinates. Common Israeli IDs: Jerusalem=281184,
  Haifa=294801, Tel Aviv=293397, Beer Sheva=295530.

## [0.2.1] - 2026-07-19

### Fixed

- README cross-links 404'd on the npm package page. The "קריאה בעברית" / "English README"
  links and the CHANGELOG link were relative paths (`README.he.md`, `README.md`,
  `CHANGELOG.md`); npm resolves those against `npmjs.com/package/`, not the GitHub repo, so they
  led to a "package not found" page. Switched all four to absolute `github.com/...` URLs, which
  work correctly on both npm and GitHub. (Docs-only change; no code affected.)

## [0.2.0] - 2026-07-19

### Added

- `ShabbatGateConfig.enforceVisitorLocation` - when `true`, the gate blocks a visitor during
  Shabbat/Yom Tov in *their own* location (from Cloudflare's `request.cf` geolocation), not
  only Israel's. The site is closed to them if it's Shabbat in Israel **or** where they are,
  so an overseas visitor stays blocked from Israel's candle-lighting right through their own
  local havdalah. Holidays for a visitor outside Israel use diaspora two-day Yom Tov reckoning
  (`i=off`); Chanukah/Purim/Yom HaAtzma'ut/Chol HaMoed stay open either way. Falls back to the
  Israel-only decision when a request has no geolocation (local `wrangler dev`, unplaceable IP).
  Defaults to `false` (original Israel-only behavior).
- **Localized secondary holding-page message.** For a visitor physically outside Israel, the
  default holding page now shows the Hebrew message, then (below a blank-line gap) a message in
  the visitor's own browser language (from `Accept-Language`). Built-in languages: English
  (default/fallback), French, Russian, Spanish, German, and Arabic (right-to-left).
  Hebrew-speaking visitors and visitors
  in Israel get no second message. Reopen time is shown in the visitor's own timezone. Works
  independently of `enforceVisitorLocation` (whenever the site is closed and the visitor is
  known to be abroad).
- New exports supporting the above: `fetchWindows` now takes an optional third `options`
  argument (`{ israelMode?, tzid? }`) for computing a non-Israel calendar; `mergeWindows`
  (coalesces overlapping window lists into continuous ones); `SUPPORTED_LANGUAGES`,
  `resolveVisitorLanguage`, and the `SecondaryMessage` / `SupportedLanguage` /
  `FetchWindowsOptions` types.

### Changed

- `HoldingPageContext` gained an optional `secondary?: SecondaryMessage` field (the localized
  block). Existing custom `renderHoldingPage` functions are unaffected - the field is optional
  and simply ignored if unused.
- The default holding page now HTML-escapes `siteName` and all label fields before
  interpolation.

## [0.1.3] - 2026-07-12

### Fixed

- **Windows were computed for the wrong location past the nearest Shabbat.** `fetchWindows`
  used to call two separate Hebcal endpoints: `/shabbat` (accurate for the given
  `latitude`/`longitude`, but - confirmed by testing live against the API - it silently
  ignores the requested `start`/`end` range and always returns only the single nearest
  Shabbat) and `/hebcal` for holidays (which took a hardcoded `geonameid` for Jerusalem,
  never the coordinates passed in). Net effect: only the very next Shabbat was ever
  correctly localized; every window after that was computed for Jerusalem regardless of
  the site's configured location.
- **Duplicate/inconsistent windows around the nearest Shabbat**, a direct consequence of
  the bug above - the two endpoints could both emit a window for the same week, a few
  minutes apart, with nothing merging or de-duplicating them.
- **A holiday's Hebrew label could leak into the following, unrelated Shabbat window.**
  `pairWindows` tracked "the most recently seen holiday item" as a running pointer. Some
  `holiday`-category items - fast days such as Tish'a B'Av, which are `maj=on` but have no
  candle-lighting/havdalah of their own - never got consumed into a window, so their label
  stayed "current" and was wrongly attached to the next real window (e.g. an ordinary
  Shabbat mislabeled with the fast day's name). Fixed by matching each window's opening
  `candles` event to a holiday via Hebcal's own `memo` field instead of positional
  tracking.

**Root fix for both window bugs**: `fetchWindows` now makes a single call to the
`/hebcal` endpoint with `ss=on` (weekly Shabbat) added alongside `maj=on` (major
holidays), passing `latitude`/`longitude` directly instead of a `geonameid`. This
returns every window in the requested range, correctly localized, already merged and
chronologically ordered - eliminating the two-source reconciliation that caused both bugs.

### Added

- `ShabbatGateConfig.bufferMinutes` - closes the site a configurable number of minutes
  *before* candle-lighting and reopens it the same number of minutes *after* havdalah, on
  top of the raw Hebcal window. Applied at decision time (not baked into the 24h cache), so
  changing it takes effect immediately.
- `createShabbatGateForWorker(config)` - an adapter for plain Cloudflare Workers with a
  static `assets` binding (as opposed to Pages Functions). Returns
  `(request: Request) => Promise<Response | null>`: `null` means "let the real site
  through", a `Response` means "serve the holding page". Shares all fail-open/caching/
  bypass logic with `createShabbatGate` internally, so the two can't drift apart.
- `INTERNAL_CACHE_KEY_URL` export - the fixed internal Workers-Cache-API key this package
  uses to cache the merged window list for ~24h. Exported so consumers doing their own
  caching of derived data (e.g. windows with a hand-rolled buffer) can pick a different key
  and avoid silently serving stale data for up to a day.

## [0.1.2] - 2026-07-10

### Fixed

- Holding page showed the generic literal "הדלקת נרות"/"הבדלה" as the closure reason for
  every window, Shabbat or holiday alike (Hebcal's `candles`/`havdalah` items always carry
  that generic text in their `hebrew` field, never the actual occasion name). Plain Shabbat
  weeks now default to "שבת קודש" (opening) / "השבת" (closing); holiday windows pick up the
  holiday's own Hebrew name (e.g. "ערב ראש השנה").

### Documentation

- Documented the Cloudflare Worker + `assets` binding `run_worker_first: true` gotcha:
  without it, requests matching a static asset are served directly and the gate's `fetch`
  handler never runs, so the site never actually closes despite looking correctly wired up.
  Found live in production on the package's first real-world Worker (non-Pages) deployment.

## [0.1.1] - 2026-07-10

### Added

- Hebrew README (`README.he.md`), for the package's primary intended audience.

## [0.1.0] - 2026-07-10

### Added

- Initial release: bot/crawler allowlist, Hebcal Shabbat + major-holiday window fetching
  (Israel single-day Yom Tov mode), `createShabbatGate` Pages Functions middleware,
  bypass query param, ~24h caching via the Workers Cache API, and fail-open error handling.
