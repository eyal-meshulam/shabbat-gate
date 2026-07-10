import { describe, expect, it } from 'vitest';
import { findActiveWindow, isBlocked, pairWindows, type Window } from './hebcal.js';

describe('pairWindows', () => {
  it('pairs a single candles/havdalah into one window', () => {
    const windows = pairWindows([
      { title: 'Candle lighting', date: '2026-08-14T18:52:00', category: 'candles' },
      { title: 'Havdalah', date: '2026-08-15T19:48:00', category: 'havdalah' },
    ]);

    expect(windows).toEqual([
      { start: new Date('2026-08-14T18:52:00').getTime(), end: new Date('2026-08-15T19:48:00').getTime(), label: 'Candle lighting' },
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
    { start: 1000, end: 2000, label: 'שבת' },
    { start: 5000, end: 6000, label: 'ראש השנה' },
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
