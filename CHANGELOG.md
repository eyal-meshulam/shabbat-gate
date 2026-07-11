# Changelog

All notable changes to this package are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

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
