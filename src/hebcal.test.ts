import { describe, expect, it } from 'vitest';
import { findActiveWindow, isBlocked, mergeWindows, pairWindows, type Window } from './hebcal.js';

describe('pairWindows', () => {
  it('pairs a single candles/havdalah into one window', () => {
    const windows = pairWindows([
      { title: 'Candle lighting', date: '2026-08-14T18:52:00', category: 'candles' },
      { title: 'Havdalah', date: '2026-08-15T19:48:00', category: 'havdalah' },
    ]);

    expect(windows).toEqual([
      {
        start: new Date('2026-08-14T18:52:00').getTime(),
        end: new Date('2026-08-15T19:48:00').getTime(),
        label: 'Candle lighting',
        closingLabel: 'Candle lighting',
      },
    ]);
  });

  it('collapses a multi-day holiday (two candles, one havdalah) into a single continuous window', () => {
    const windows = pairWindows([
      { title: 'Rosh Hashana 5787', date: '2026-09-11T18:40:00', category: 'candles' },
      { title: 'Rosh Hashana II', date: '2026-09-12T19:36:00', category: 'candles' },
      { title: 'Havdalah', date: '2026-09-13T19:33:00', category: 'havdalah' },
    ]);

    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBe(new Date('2026-09-11T18:40:00').getTime());
    expect(windows[0].end).toBe(new Date('2026-09-13T19:33:00').getTime());
  });

  it('uses the given defaults for a plain Shabbat window (no holiday item nearby)', () => {
    const windows = pairWindows(
      [
        {
          title: 'Candle lighting',
          hebrew: 'הדלקת נרות',
          date: '2026-08-14T18:52:00',
          category: 'candles',
          memo: 'Parashat Re\'eh',
        },
        { title: 'Havdalah', hebrew: 'הבדלה', date: '2026-08-15T19:48:00', category: 'havdalah' },
      ],
      { label: 'שבת קודש', closingLabel: 'השבת' },
    );

    expect(windows).toEqual([
      {
        start: new Date('2026-08-14T18:52:00').getTime(),
        end: new Date('2026-08-15T19:48:00').getTime(),
        label: 'שבת קודש',
        closingLabel: 'השבת',
      },
    ]);
  });

  it('uses the matching holiday item\'s own Hebrew name instead of the generic candle-lighting text', () => {
    const windows = pairWindows(
      [
        { title: 'Erev Rosh Hashana', hebrew: 'ערב ראש השנה', date: '2026-09-11', category: 'holiday' },
        {
          title: 'Candle lighting',
          hebrew: 'הדלקת נרות',
          date: '2026-09-11T18:10:00',
          category: 'candles',
          memo: 'Erev Rosh Hashana',
        },
        { title: 'Havdalah', hebrew: 'הבדלה', date: '2026-09-13T19:24:00', category: 'havdalah' },
      ],
      { label: 'שבת קודש', closingLabel: 'השבת' },
    );

    expect(windows[0].label).toBe('ערב ראש השנה');
    expect(windows[0].closingLabel).toBe('ערב ראש השנה');
  });

  it('does not leak a fast day\'s holiday label into the next, unrelated Shabbat window', () => {
    // Regression test: Tish'a B'Av is `holiday`-category (maj=on) but has no
    // candle-lighting of its own - naively tracking "last holiday label
    // seen" would wrongly attach its name to the following week's ordinary
    // Shabbat, which has no `memo` match for it.
    const windows = pairWindows(
      [
        { title: 'Erev Tish’a B’Av', hebrew: 'ערב תשעה באב', date: '2026-07-22', category: 'holiday' },
        { title: 'Tish’a B’Av', hebrew: 'תשעה באב', date: '2026-07-23', category: 'holiday' },
        {
          title: 'Candle lighting',
          hebrew: 'הדלקת נרות',
          date: '2026-07-24T19:01:00',
          category: 'candles',
          memo: 'Parashat Vaetchanan',
        },
        { title: 'Havdalah', hebrew: 'הבדלה', date: '2026-07-25T20:02:00', category: 'havdalah' },
      ],
      { label: 'שבת קודש', closingLabel: 'השבת' },
    );

    expect(windows).toHaveLength(1);
    expect(windows[0].label).toBe('שבת קודש');
    expect(windows[0].closingLabel).toBe('השבת');
  });

  it('produces multiple independent windows across unrelated events', () => {
    const windows = pairWindows([
      { title: 'Shabbat 1', date: '2026-08-14T18:52:00', category: 'candles' },
      { title: 'Havdalah 1', date: '2026-08-15T19:48:00', category: 'havdalah' },
      { title: 'Shabbat 2', date: '2026-08-21T18:45:00', category: 'candles' },
      { title: 'Havdalah 2', date: '2026-08-22T19:40:00', category: 'havdalah' },
    ]);

    expect(windows).toHaveLength(2);
  });
});

describe('isBlocked / findActiveWindow', () => {
  const windows: Window[] = [
    { start: 1000, end: 2000, label: 'שבת', closingLabel: 'השבת' },
    { start: 5000, end: 6000, label: 'ראש השנה', closingLabel: 'ראש השנה' },
  ];

  it('reports blocked when now falls inside a window', () => {
    expect(isBlocked(windows, 1500)).toBe(true);
    expect(findActiveWindow(windows, 1500)?.label).toBe('שבת');
  });

  it('reports not blocked when now falls outside all windows', () => {
    expect(isBlocked(windows, 3000)).toBe(false);
    expect(findActiveWindow(windows, 3000)).toBeUndefined();
  });

  it('treats the window as [start, end) - end is exclusive', () => {
    expect(isBlocked(windows, 2000)).toBe(false);
    expect(isBlocked(windows, 1999)).toBe(true);
  });
});

describe('mergeWindows', () => {
  it('leaves non-overlapping windows untouched (just sorted)', () => {
    const merged = mergeWindows([
      { start: 5000, end: 6000, label: 'ב', closingLabel: 'ב' },
      { start: 1000, end: 2000, label: 'א', closingLabel: 'א' },
    ]);

    expect(merged).toEqual([
      { start: 1000, end: 2000, label: 'א', closingLabel: 'א' },
      { start: 5000, end: 6000, label: 'ב', closingLabel: 'ב' },
    ]);
  });

  it('coalesces two overlapping windows into one, keeping the later end + its label', () => {
    // Israel Shabbat [100, 500) overlaps the visitor's local Shabbat [300, 900):
    // the union is one continuous block [100, 900) that reopens at the visitor's
    // later havdalah, labelled with the occasion still keeping them blocked.
    const merged = mergeWindows([
      { start: 100, end: 500, label: 'שבת (ישראל)', closingLabel: 'השבת' },
      { start: 300, end: 900, label: 'שבת (מקומי)', closingLabel: 'השבת המקומית' },
    ]);

    expect(merged).toEqual([
      { start: 100, end: 900, label: 'שבת (מקומי)', closingLabel: 'השבת המקומית' },
    ]);
  });

  it('keeps the earlier window\'s label when a later window is fully contained', () => {
    const merged = mergeWindows([
      { start: 100, end: 900, label: 'חיצוני', closingLabel: 'חיצוני' },
      { start: 300, end: 500, label: 'פנימי', closingLabel: 'פנימי' },
    ]);

    expect(merged).toEqual([
      { start: 100, end: 900, label: 'חיצוני', closingLabel: 'חיצוני' },
    ]);
  });

  it('does not merge windows that only touch at the boundary end === start', () => {
    // Windows are [start, end) half-open, so [100,200) and [200,300) don't
    // actually overlap - but treating end===start as contiguous is harmless and
    // avoids a spurious 1ms reopen gap, so they DO get merged here.
    const merged = mergeWindows([
      { start: 100, end: 200, label: 'א', closingLabel: 'א' },
      { start: 200, end: 300, label: 'ב', closingLabel: 'ב' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ start: 100, end: 300, label: 'ב', closingLabel: 'ב' });
  });

  it('does not mutate the input windows', () => {
    const input: Window[] = [
      { start: 100, end: 500, label: 'א', closingLabel: 'א' },
      { start: 300, end: 900, label: 'ב', closingLabel: 'ב' },
    ];
    mergeWindows(input);

    expect(input[0].end).toBe(500);
  });
});
