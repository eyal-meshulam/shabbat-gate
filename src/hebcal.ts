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
}

interface HebcalResponse {
  items?: HebcalItem[];
}

const HEBCAL_JERUSALEM_GEONAME_ID = 281184;

/** Hebcal's own "candles"/"havdalah" items always carry the generic literal
 *  "הדלקת נרות"/"הבדלה" in their `hebrew` field, never the occasion name - so
 *  it's unusable as a display label on its own. For a plain Shabbat week
 *  (no accompanying `holiday` item), fall back to this fixed pair instead. */
const SHABBAT_LABEL = 'שבת קודש';
const SHABBAT_CLOSING_LABEL = 'השבת';

/**
 * Pairs candles/havdalah events into continuous windows. Multi-day holidays
 * (e.g. Rosh Hashana) emit two "candles" events but only one "havdalah" at the
 * very end, so candles cannot simply be paired 1:1 with the next havdalah.
 * Instead: open a window on the first candles seen while none is open, ignore
 * further candles while one is open, and close on the next havdalah.
 *
 * `defaults` overrides the label for windows that have no `holiday`-category
 * item nearby (i.e. plain Shabbat weeks) - pass it when calling this with the
 * Shabbat endpoint's items. Holiday windows always pick up the most recent
 * `holiday` item's own Hebrew name instead (e.g. "ערב ראש השנה"), since that's
 * far more informative than the generic candle-lighting text.
 */
export function pairWindows(items: HebcalItem[], defaults?: { label: string; closingLabel: string }): Window[] {
  const windows: Window[] = [];
  let openStart: number | null = null;
  let openLabel = '';
  let openClosingLabel = '';
  let lastHolidayLabel: string | null = null;

  for (const item of items) {
    if (item.category === 'holiday') {
      lastHolidayLabel = item.hebrew ?? item.title;
    }
    if (item.category === 'candles') {
      if (openStart === null) {
        openStart = new Date(item.date).getTime();
        const label = lastHolidayLabel ?? defaults?.label ?? item.hebrew ?? item.title;
        openLabel = label;
        openClosingLabel = lastHolidayLabel ? label : (defaults?.closingLabel ?? label);
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
      lastHolidayLabel = null;
    }
  }

  return windows;
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Fetches and merges Shabbat + major-holiday (Israel single-day Yom Tov mode)
 * windows for the next ~45 days from Hebcal's free public JSON API.
 */
export async function fetchWindows(latitude: number, longitude: number): Promise<Window[]> {
  const start = new Date();
  const end = new Date(start.getTime() + 45 * 24 * 60 * 60 * 1000);
  const startParam = toISODate(start);
  const endParam = toISODate(end);

  const shabbatUrl =
    `https://www.hebcal.com/shabbat?cfg=json&latitude=${latitude}&longitude=${longitude}` +
    `&tzid=Asia/Jerusalem&M=on&start=${startParam}&end=${endParam}`;

  // i=on = Israel single-day Yom Tov reckoning (not diaspora 2-day).
  // c=on = attach candles/havdalah entries to holidays, not just bare dates.
  // maj=on + everything else off = only real work-restricted Yom Tov days.
  const holidayUrl =
    `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=off&mod=off&nx=off&mf=off&ss=off` +
    `&c=on&i=on&geonameid=${HEBCAL_JERUSALEM_GEONAME_ID}&start=${startParam}&end=${endParam}`;

  const [shabbatRes, holidayRes] = await Promise.all([fetch(shabbatUrl), fetch(holidayUrl)]);

  if (!shabbatRes.ok || !holidayRes.ok) {
    throw new Error(`hebcal fetch failed: shabbat=${shabbatRes.status} holiday=${holidayRes.status}`);
  }

  const [shabbatData, holidayData] = (await Promise.all([
    shabbatRes.json(),
    holidayRes.json(),
  ])) as [HebcalResponse, HebcalResponse];

  const windows = [
    ...pairWindows(shabbatData.items ?? [], { label: SHABBAT_LABEL, closingLabel: SHABBAT_CLOSING_LABEL }),
    ...pairWindows(holidayData.items ?? []),
  ];

  return windows.sort((a, b) => a.start - b.start);
}

/** Pure function: is `now` inside any of the given windows? */
export function isBlocked(windows: Window[], now: number): boolean {
  return findActiveWindow(windows, now) !== undefined;
}

/** Pure function: the window covering `now`, if any. */
export function findActiveWindow(windows: Window[], now: number): Window | undefined {
  return windows.find((w) => w.start <= now && now < w.end);
}
