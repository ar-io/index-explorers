/**
 * An answer drawn before its table: which columns a question charts, and the
 * points that come out of its rows. Pure, so it is tested without a page.
 */
import { fileType, type ChartData, type ChartPoint } from '@ar-io/explorer-ui';
import { bytesText, num, shortId } from '@ar-io/index-client';

import { columnLabel } from './questions.js';

/** One way to chart an answer; a question lists one per form of its SQL. */
export interface ChartSpec {
  /** Ranked bars, a name, a bar and a figure per row; or columns over time. */
  form: 'bars' | 'columns';
  /** Joined with a space into each row's name. */
  label: string[];
  /** One measure, or two that stack (public and private). Never two scales. */
  series: string[];
}

/** GiB and MiB columns hold rounded sizes: written back as bytes are elsewhere. */
const UNIT: Record<string, number> = { gib: 2 ** 30, mib: 2 ** 20 };

const figure = (key: string, v: number): string =>
  UNIT[key] ? bytesText(Math.round(v * UNIT[key]!)) : num(v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A row's name: an id shortened, a month in words, a bucket without its sort prefix. */
function nameOf(key: string, v: unknown): string {
  const t = v === null || v === undefined ? '' : String(v);
  if (/^[A-Za-z0-9_-]{43}$/.test(t)) return shortId(t);
  const m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m && key === 'month') return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  if (key === 'size_bucket') return t.replace(/^[a-z]\. /, '');
  if ((key === 'type' || key === 'content_type') && t.includes('/')) return fileType(t);
  return t;
}

/**
 * The first spec whose columns the rows have (a question's period form and
 * its all-history form name different columns), as points; null when none
 * fits, or there are fewer than two rows to compare.
 */
export function buildChart(
  specs: readonly ChartSpec[] | undefined,
  cols: readonly string[],
  rows: readonly Record<string, unknown>[],
): ChartData | null {
  if (!specs || rows.length < 2) return null;
  const have = new Set(cols);
  const spec = specs.find((s) => [...s.label, ...s.series].every((c) => have.has(c)));
  if (!spec) return null;
  const points: ChartPoint[] = rows.map((r) => {
    const values = spec.series.map((k) => {
      const v = Number(r[k]);
      return Number.isFinite(v) && v > 0 ? v : 0;
    });
    const total = values.reduce((a, b) => a + b, 0);
    return {
      label: spec.label
        .map((k) => nameOf(k, r[k]))
        .filter(Boolean)
        .join(' '),
      values,
      text:
        spec.series.length === 1
          ? figure(spec.series[0]!, total)
          : spec.series.map((k, i) => `${columnLabel(k)} ${figure(k, values[i]!)}`).join(', '),
    };
  });
  const max = Math.max(0, ...points.map((p) => p.values.reduce((a, b) => a + b, 0)));
  if (!(max > 0)) return null;
  return { form: spec.form, series: spec.series.map(columnLabel), points, max };
}
