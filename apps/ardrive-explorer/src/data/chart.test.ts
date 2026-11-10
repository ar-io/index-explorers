import { describe, expect, it } from 'vitest';

import { buildChart, type ChartSpec } from './chart.js';

const bars: ChartSpec[] = [
  { form: 'bars', label: ['type'], series: ['gib'] },
  { form: 'bars', label: ['type'], series: ['uploads'] },
];

describe('buildChart', () => {
  it('takes the first spec whose columns the answer has', () => {
    const c = buildChart(
      bars,
      ['type', 'uploads'],
      [
        { type: 'image/png', uploads: 30 },
        { type: 'video/mp4', uploads: 10n },
      ],
    );
    expect(c?.series).toEqual(['Uploads']);
    expect(c?.points.map((p) => p.values[0])).toEqual([30, 10]);
    expect(c?.max).toBe(30);
  });

  it('writes sizes as bytes, ids short, months in words, buckets without their prefix', () => {
    const c = buildChart(
      [{ form: 'bars', label: ['owner'], series: ['gib'] }],
      ['owner', 'gib'],
      [
        { owner: 'dBRMGwLFzqr7V6CSNU6ZwcrDfDI20Y1vdZfpBQINbNU', gib: 7.34 },
        { owner: 'XAm3iZSQqsn5SQzGQD0WYVCQ1TVL_t1JQTcy9p0Kxs8', gib: 0.19 },
      ],
    )!;
    expect(c.points[0]!.label).toBe('dBRMGw…NbNU');
    expect(c.points[0]!.text).toBe('7.34 GB');
    const m = buildChart(
      [{ form: 'columns', label: ['month'], series: ['public_drives', 'private_drives'] }],
      ['month', 'public_drives', 'private_drives', 'owners'],
      [
        { month: '2026-09', public_drives: 4, private_drives: 1 },
        { month: '2026-10', public_drives: 2, private_drives: 3 },
      ],
    )!;
    expect(m.points.map((p) => p.label)).toEqual(['Sep 2026', 'Oct 2026']);
    expect(m.points[1]!.text).toBe('Public drives 2, Private drives 3');
    expect(m.max).toBe(5);
    const b = buildChart(
      [{ form: 'bars', label: ['size_bucket'], series: ['uploads'] }],
      ['size_bucket', 'uploads'],
      [
        { size_bucket: 'a. under 1 KB', uploads: 9 },
        { size_bucket: 'e. 100 MB and up', uploads: 1 },
      ],
    )!;
    expect(b.points.map((p) => p.label)).toEqual(['under 1 KB', '100 MB and up']);
  });

  it('draws nothing for one row, no matching spec, or nothing to measure', () => {
    expect(buildChart(bars, ['type', 'gib'], [{ type: 'a', gib: 1 }])).toBeNull();
    expect(buildChart(bars, ['x', 'y'], [{ x: 1 }, { x: 2 }])).toBeNull();
    expect(
      buildChart(
        bars,
        ['type', 'gib'],
        [
          { type: 'a', gib: 0 },
          { type: 'b', gib: null },
        ],
      ),
    ).toBeNull();
    expect(buildChart(undefined, ['type'], [{}, {}])).toBeNull();
  });
});
