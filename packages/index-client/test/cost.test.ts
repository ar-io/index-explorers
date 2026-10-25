import { describe, expect, it } from 'vitest';

import {
  buildPeriods,
  clusterHeights,
  heightAt,
  parsePublication,
  selectIndex,
  sliceWindow,
  timeAt,
} from '../src/index.js';
import { GATEWAY, LIVE_PUBLICATION, readJson } from './helpers.js';

const ix = selectIndex(parsePublication(readJson(LIVE_PUBLICATION)), 'ardrive-l2', {
  gateway: GATEWAY,
});
const bands = ix.bands;

describe('periods and dates', () => {
  const dated = bands.map((b) => ({
    ...b,
    fromTime: 1_500_000_000 + (b.from / 100000) * 86400 * 30,
    toTime: 1_500_000_000 + ((b.to ?? b.from) / 100000) * 86400 * 30,
  }));
  const tip = dated[dated.length - 1]!.to!;
  const tipTime = dated[dated.length - 1]!.toTime!;

  it('interpolates heights from band edge dates, and back', () => {
    const b = dated[3]!;
    const mid = (b.fromTime! + b.toTime!) / 2;
    const h = heightAt(dated, mid, tip, tipTime);
    expect(h).toBeGreaterThan(b.from);
    expect(h).toBeLessThan(b.to!);
    expect(Math.abs(timeAt(dated, h)! - mid)).toBeLessThan(3600);
    expect(timeAt(bands, 905000)).toBeNull();
  });

  it('builds week, month, quarter, year, calendar years and all history with sizes', () => {
    const ps = buildPeriods(dated, {
      tip,
      tipTime,
      scanFiles: ['tags.parquet', 'data_items.parquet'],
    });
    const ids = ps.map((p) => p.id);
    expect(ids.slice(0, 4)).toEqual(['week', 'month', 'quarter', 'year']);
    expect(ids.at(-1)).toBe('all');
    expect(ids.some((i) => /^y\d{4}$/.test(i))).toBe(true);
    const all = ps.at(-1)!;
    expect(all.lo).toBe(bands[0]!.from);
    expect(all.hi).toBe(tip);
    expect(all.size).toBeCloseTo(
      bands.reduce(
        (t, b) => t + b.files.get('tags.parquet')!.size + b.files.get('data_items.parquet')!.size,
        0,
      ),
      -2,
    );
    const week = ps[0]!;
    expect(week.hi).toBe(tip);
    expect(week.lo).toBeLessThan(tip);
    expect(week.size).toBeLessThan(ps[1]!.size);
  });

  it('falls back to two-minute blocks without dates', () => {
    const ps = buildPeriods(bands, {
      tip: 2024964,
      tipTime: 1792465449,
      scanFiles: ['tags.parquet'],
    });
    expect(ps[0]!.lo).toBe(2024964 - 7 * 720);
  });
});

describe('clusters and slices', () => {
  it('clusters heights by gap and slices windows evenly', () => {
    expect(clusterHeights([1, 2, 300, 301, 302, 1000])).toEqual([
      [1, 2],
      [300, 302],
      [1000, 1000],
    ]);
    expect(sliceWindow(0, 12000, 5000)).toEqual([
      [0, 4999],
      [5000, 9999],
      [10000, 12000],
    ]);
  });
});
