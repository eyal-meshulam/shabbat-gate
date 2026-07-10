export interface Window {
  start: number;
  end: number;
  label: string;
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

/**
 * Pairs candles/havdalah events into continuous windows. Multi-day holidays
 * (e.g. Rosh Hashana) emit two "candles" events but only one "havdalah" at the
 * very end, so candles cannot simply be paired 1:1 with the next havdalah.
 * Instead: open a window on the first candles seen while none is open, ignore
 * further candles while one is open, and close on the next havdalah.
 */
export function pairWindows(items: HebcalItem[]): Window[] {
  const windows: Window[] = [];
  let openStart: number | null = null;
  let openLabel = '';

  for (const item of items) {
    if (item.category === 'candles') {
      if (openStart === null) {
        openStart = new Date(item.date).getTime();
        openLabel = item.hebrew ?? item.title;
      }
    } else if (item.category === 'havdalah' && openStart !== null) {
      windows.push({ start: openStart, end: new Date(item.date).getTime(), label: openLabel });
      openStart = null;
      openLabel = '';
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
    ...pairWindows(shabbatData.items ?? []),
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
