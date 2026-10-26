/**
 * Periods and heights: the periods a reader is offered, what each holds from
 * the bands' signed sizes, and turning dates into heights. What a listing
 * will read is not guessed here: `planReads` (engine/read-ahead.ts) works it
 * out from the files' footers.
 */
import type { Band } from './publication.js';

/** Row groups are 122,880 rows, about 250 blocks on the busy bands: the default gap between stretches. */
export const ROW_GROUP_BLOCKS = 250;
/** About two minutes a block: only for turning "last 30 days" into a height when no dates are known. */
export const BLOCKS_PER_DAY = 720;

/** The size of the files a listing may read in a band (tables, not lookups). */
export const bandScanSize = (b: Band, files: readonly string[]): number =>
  files.reduce((t, f) => t + (b.files.get(f)?.size ?? 0), 0);

/** The block nearest a time, from the band edges' dates, else by two-minute blocks from the tip. */
export function heightAt(
  bands: readonly Band[],
  secs: number,
  tip: number,
  tipTime: number,
): number {
  for (const b of bands) {
    if (b.fromTime && b.toTime && b.to !== null && secs >= b.fromTime && secs <= b.toTime) {
      const f = (secs - b.fromTime) / Math.max(1, b.toTime - b.fromTime);
      return Math.round(b.from + f * (b.to - b.from));
    }
  }
  const first = bands[0]?.from ?? 0;
  return Math.max(first, Math.round(tip - ((tipTime - secs) / 86400) * BLOCKS_PER_DAY));
}

/** The reverse of heightAt, for labels: epoch seconds, or null without dates. */
export function timeAt(bands: readonly Band[], h: number): number | null {
  const b = bands.find((x) => h >= x.from && h <= (x.to ?? Infinity));
  if (!b || !b.fromTime || !b.toTime || b.to === null) return null;
  return b.fromTime + ((h - b.from) / Math.max(1, b.to - b.from)) * (b.toTime - b.fromTime);
}

export interface Period {
  id: string;
  label: string;
  lo: number;
  hi: number;
  /** The bands the period touches. */
  bands: Band[];
  /** The pro-rata share of the bands' scan files, in bytes: what a question over it could read. */
  size: number;
}

export interface PeriodOptions {
  /** The newest height the bands reach. */
  tip: number;
  /** Epoch seconds of the tip, when known. */
  tipTime?: number;
  /** The files a question scans, for `size`. */
  scanFiles: readonly string[];
  now?: number;
}

/**
 * Periods a reader understands: the last 7, 30, 90 and 365 days, each
 * calendar year the bands cover, and all history. Days become heights through
 * the band edges' dates when known, else through two-minute blocks.
 */
export function buildPeriods(bands: readonly Band[], opts: PeriodOptions): Period[] {
  if (!bands.length) return [];
  const first = bands[0]!;
  const tipTime =
    opts.tipTime ?? bands[bands.length - 1]!.toTime ?? (opts.now ?? Date.now()) / 1000;
  const dayAgo = (d: number) => heightAt(bands, tipTime - d * 86400, opts.tip, tipTime);
  const out: Period[] = [];
  const add = (id: string, label: string, lo: number, hi: number) => {
    const touched = bands.filter((b) => (b.to ?? Infinity) >= lo && b.from <= hi);
    const size = touched.reduce((t, b) => {
      const to = b.to ?? hi;
      const frac = (Math.min(to, hi) - Math.max(b.from, lo) + 1) / (to - b.from + 1);
      return t + bandScanSize(b, opts.scanFiles) * frac;
    }, 0);
    out.push({ id, label, lo, hi, bands: touched, size });
  };
  add('week', 'Last 7 days', dayAgo(7), opts.tip);
  add('month', 'Last 30 days', dayAgo(30), opts.tip);
  add('quarter', 'Last 90 days', dayAgo(90), opts.tip);
  add('year', 'Last 12 months', dayAgo(365), opts.tip);
  if (bands.every((b) => b.fromTime && b.toTime)) {
    const y0 = new Date(first.fromTime! * 1000).getUTCFullYear();
    const y1 = new Date(tipTime * 1000).getUTCFullYear();
    for (let y = y1; y >= y0; y--) {
      const a = Date.UTC(y, 0, 1) / 1000;
      const z = Date.UTC(y + 1, 0, 1) / 1000 - 1;
      add(
        'y' + y,
        String(y),
        Math.max(first.from, heightAt(bands, a, opts.tip, tipTime)),
        Math.min(opts.tip, heightAt(bands, z, opts.tip, tipTime)),
      );
    }
  }
  add('all', 'All history', first.from, opts.tip);
  return out;
}

/** Heights clustered into stretches: a gap wider than `gap` blocks starts a new one. */
export function clusterHeights(
  heights: readonly number[],
  gap = ROW_GROUP_BLOCKS,
): [number, number][] {
  const clusters: [number, number][] = [];
  for (const h of heights) {
    const last = clusters[clusters.length - 1];
    if (last && h - last[1] <= gap) last[1] = h;
    else clusters.push([h, h]);
  }
  return clusters;
}

/** A window cut into slices of at most `size` blocks, so memory stays flat however wide the window. */
export function sliceWindow(lo: number, hi: number, size = 5000): [number, number][] {
  const out: [number, number][] = [];
  for (let a = lo; a <= hi; a += size) out.push([a, Math.min(a + size - 1, hi)]);
  return out;
}

/** Stretches of heights sorted, overlapping or touching ones merged, then each cut into slices of at most `size` blocks. */
export function mergeStretches(
  stretches: readonly (readonly [number, number])[],
  size = 5000,
): [number, number][] {
  const merged: [number, number][] = [];
  for (const [a, b] of [...stretches].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged.flatMap(([a, b]) => sliceWindow(a, b, size));
}
