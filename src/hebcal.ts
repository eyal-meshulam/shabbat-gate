export interface Window {
  start: number;
  end: number;
  /** Hebrew label for "the site is closed for ___". */
  label: string;
  /** Hebrew label for "back after ___ [ends]" - grammatically distinct from
   *  `label` for Shabbat ("שבת קודש" opening vs. "השבת" closing). */
  closingLabel: string;
}

interface HebcalItem {
  title: string;
  hebrew?: string;
  date: string;
  category: string;
  /** Present on `candles`/`havdalah` items: the title of the holiday/parasha
   *  it belongs to (e.g. "Erev Rosh Hashana", or "Parashat Devarim" for a
   *  plain Shabbat week). Used to cross-reference against `holiday` items'
   *  own `title` to find the right Hebrew label for *this specific* window,
   *  instead of trusting whichever `holiday` item happened to appear most
   *  recently in the feed (which leaks into unrelated windows - see below). */
  memo?: string;
}

interface HebcalResponse {
  items?: HebcalItem[];
}

/** Hebcal's own "candles"/"havdalah" items always carry the generic literal
 *  "הדלקת נרות"/"הבדלה" in their `hebrew` field, never the occasion name - so
 *  it's unusable as a display label on its own. For a plain Shabbat week
 *  (no accompanying `holiday` item), fall back to this fixed pair instead. */
export const SHABBAT_LABEL = 'שבת קודש';
export const SHABBAT_CLOSING_LABEL = 'השבת';

/**
 * Pairs candles/havdalah events into continuous windows. Multi-day holidays
 * (e.g. Rosh Hashana) emit two "candles" events but only one "havdalah" at the
 * very end, so candles cannot simply be paired 1:1 with the next havdalah.
 * Instead: open a window on the first candles seen while none is open, ignore
 * further candles while one is open, and close on the next havdalah.
 *
 * `defaults` overrides the label for windows that have no matching `holiday`
 * item (i.e. plain Shabbat weeks) - pass it when calling this with a merged
 * feed that mixes weekly Shabbat and holiday items together.
 *
 * Holiday windows pick up the matching `holiday` item's own Hebrew name (e.g.
 * "ערב ראש השנה") by matching the opening `candles` item's `memo` field
 * against a `holiday` item's `title` - not just "the most recent holiday item
 * seen so far". Some `holiday`-category items (e.g. fast days like תשעה באב,
 * which are `maj=on` but have no candle-lighting of their own) never get
 * consumed by a window; naively tracking "last holiday label seen" would leak
 * their label into the next, unrelated Shabbat window instead of falling back
 * to `defaults`.
 */
export function pairWindows(items: HebcalItem[], defaults?: { label: string; closingLabel: string }): Window[] {
  const windows: Window[] = [];
  const holidayTitles = new Map<string, string>();
  let openStart: number | null = null;
  let openLabel = '';
  let openClosingLabel = '';

  for (const item of items) {
    if (item.category === 'holiday') {
      holidayTitles.set(item.title, item.hebrew ?? item.title);
    }
    if (item.category === 'candles') {
      if (openStart === null) {
        openStart = new Date(item.date).getTime();
        const matchedHoliday = item.memo ? holidayTitles.get(item.memo) : undefined;
        const label = matchedHoliday ?? defaults?.label ?? item.hebrew ?? item.title;
        openLabel = label;
        openClosingLabel = matchedHoliday ? label : (defaults?.closingLabel ?? label);
      }
    } else if (item.category === 'havdalah' && openStart !== null) {
      windows.push({
        start: openStart,
        end: new Date(item.date).getTime(),
        label: openLabel,
        closingLabel: openClosingLabel,
      });
      openStart = null;
      openLabel = '';
      openClosingLabel = '';
    }
  }

  return windows;
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FetchWindowsOptions {
  /** `true` (default) = Israel single-day Yom Tov reckoning (`i=on`). `false` =
   *  diaspora two-day Yom Tov reckoning (`i=off`), correct for a visitor
   *  physically outside Israel. Only affects how many days a *Torah* Yom Tov
   *  spans - the `maj=on&min=off&mod=off` filter is independent of `i`, so
   *  Chanukah/Purim/Yom HaAtzma'ut/Chol HaMoed stay excluded either way. */
  israelMode?: boolean;
  /** IANA timezone the candle-lighting/havdalah times are computed against
   *  (defaults to `'Asia/Jerusalem'`). Pass the visitor's own timezone when
   *  computing their local windows so day boundaries line up with their sunset,
   *  not Jerusalem's. */
  tzid?: string;
}

/**
 * Fetches and merges Shabbat + major-holiday windows for the next ~45 days from
 * Hebcal's free public JSON API. Defaults to Israel single-day Yom Tov mode at
 * Jerusalem's timezone; pass `options` to compute windows for a visitor's own
 * location/reckoning instead (see {@link FetchWindowsOptions}).
 *
 * Uses a *single* call to the `/hebcal` endpoint (not the separate `/shabbat`
 * endpoint) with `ss=on` added, passing `latitude`/`longitude` directly
 * instead of a `geonameid`. Two real bugs motivated this over the previous
 * two-call approach: (1) `/shabbat?start=...&end=...` silently ignores the
 * requested range and only ever returns the single nearest Shabbat,
 * regardless of how far out `end` is; (2) `geonameid` always resolves to a
 * fixed city (Jerusalem), so every week after the nearest one was computed
 * for the wrong location instead of the coordinates passed in. Querying
 * `/hebcal` with `ss=on` + lat/long returns every Shabbat and holiday in the
 * range, correctly localized, in one chronologically-ordered, already-merged
 * list - which also means there's nothing left to de-duplicate.
 */
export async function fetchWindows(
  latitude: number,
  longitude: number,
  options: FetchWindowsOptions = {},
): Promise<Window[]> {
  const israelMode = options.israelMode ?? true;
  const tzid = options.tzid ?? 'Asia/Jerusalem';

  const start = new Date();
  const end = new Date(start.getTime() + 45 * 24 * 60 * 60 * 1000);
  const startParam = toISODate(start);
  const endParam = toISODate(end);

  // i=on = Israel single-day Yom Tov reckoning; i=off = diaspora 2-day.
  // c=on = attach candles/havdalah entries to holidays, not just bare dates.
  // ss=on = weekly Shabbat candle-lighting/havdalah, localized to lat/long.
  // maj=on + everything else off = only real work-restricted Yom Tov days.
  const iParam = israelMode ? 'on' : 'off';
  const url =
    `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=off&mod=off&nx=off&mf=off&ss=on` +
    `&c=on&i=${iParam}&latitude=${latitude}&longitude=${longitude}&tzid=${encodeURIComponent(tzid)}` +
    `&start=${startParam}&end=${endParam}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`hebcal fetch failed: ${res.status}`);
  }

  const data = (await res.json()) as HebcalResponse;

  const windows = pairWindows(data.items ?? [], { label: SHABBAT_LABEL, closingLabel: SHABBAT_CLOSING_LABEL });

  return windows.sort((a, b) => a.start - b.start);
}

/**
 * Coalesces overlapping/touching windows into continuous ones. Needed when two
 * independently-computed window lists are unioned (e.g. Israel's Shabbat and a
 * foreign visitor's local Shabbat, which partially overlap): naively searching
 * the concatenated list with {@link findActiveWindow} would return whichever
 * matching window comes first and report *its* `end`, so a visitor sitting
 * inside both windows could be told the site reopens at Israel's (earlier)
 * havdalah while they're still blocked by their own later one. Merging first
 * makes the reported reopen time the true end of the combined block.
 *
 * When two windows overlap, the merged window keeps the label of whichever one
 * ends *later* - that's the occasion actually keeping the visitor blocked, and
 * the one whose end time is shown.
 */
export function mergeWindows(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: Window[] = [];

  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      if (w.end > last.end) {
        last.end = w.end;
        last.label = w.label;
        last.closingLabel = w.closingLabel;
      }
    } else {
      merged.push({ ...w });
    }
  }

  return merged;
}

/** Pure function: is `now` inside any of the given windows? */
export function isBlocked(windows: Window[], now: number): boolean {
  return findActiveWindow(windows, now) !== undefined;
}

/** Pure function: the window covering `now`, if any. */
export function findActiveWindow(windows: Window[], now: number): Window | undefined {
  return windows.find((w) => w.start <= now && now < w.end);
}
