/**
 * SQL: the questions and the editor. A question over a period too big to
 * scan runs its lookup-based form instead (exact counts, kilobytes); a typed
 * query over such a period asks first.
 */
import {
  columnsOf,
  fmtRange,
  isUuid,
  mb,
  num,
  rowsOf,
  timeAt,
  timeColumnsOf,
} from '@ar-io/index-client';

import { CONFIG } from '../config.js';
import { captionSegments, QUESTIONS } from './questions.js';
import type { Session } from '../session.js';
import { emptyContent } from '../store.js';

export interface RunOptions {
  title?: string | null;
  caption?: string | null;
  confirmed?: boolean;
  sql?: string;
}

export function createQueryFlow(s: Session) {
  const st = s.store;
  let busy = false;

  async function runQuery(opts: RunOptions = {}): Promise<void> {
    const sql = (opts.sql ?? st.sql.value).trim().replace(/;+\s*$/, '');
    if (!sql || busy) return;
    const my = ++s.nav;
    if (!(await s.ready()) || s.overtaken(my)) return;
    s.clearView();
    const title = opts.title ?? 'Your query';
    st.content.value = { ...emptyContent(), title };
    if (!opts.confirmed) s.pushHistory({ kind: 'query', sql });
    const p0 = st.currentPeriod()!;
    if (
      p0.bands.every((b) => s.isRangeable(b)) &&
      p0.size > CONFIG.askFirstPeriod &&
      !opts.confirmed
    ) {
      // A question over years of ArDrive reads most of the period's tables:
      // hundreds of megabytes, and more memory than some tabs have. Said first.
      st.content.value = {
        ...st.content.value,
        cost: {
          text: [
            `${p0.label} holds about `,
            mb(p0.size),
            ' of index. A question over it can read most of that, and one that groups every upload may need more memory than this tab has. Pick a shorter period, or add a WHERE height BETWEEN.',
          ],
          action: {
            label: `Run it over ${p0.label}`,
            go: () => void runQuery({ ...opts, sql, confirmed: true }),
          },
        },
      };
      return;
    }
    busy = true;
    try {
      const p = st.currentPeriod()!;
      const t0 = performance.now();
      const r = await s.measured('Reading', () => s.engine!.query(sql));
      if (!r || s.overtaken(my)) return;
      const table = r.out;
      const secs = ((performance.now() - t0) / 1000).toFixed(2);
      const rows = rowsOf(table);
      const cols = columnsOf(table);
      const isTime = timeColumnsOf(table);
      const when = fmtRange(timeAt(s.bands, p.lo), timeAt(s.bands, p.hi));
      const caption = opts.caption
        ? opts.caption.replace(
            '{RANGE}',
            when ? `from ${when}` : `over blocks ${num(p.lo)} to ${num(p.hi)}`,
          )
        : null;
      st.content.value = {
        ...emptyContent(),
        title,
        caption,
        table: { cols: cols.map((c) => ({ key: c, label: c })), rows: rows.slice(0, 200), isTime },
        exportable: { cols, rows, isTime, slug: 'query' },
      };
      const more =
        rows.length > 200 ? 'Showing the first 200 rows; CSV and JSON have them all. ' : '';
      st.say(
        `${num(rows.length)} row${rows.length === 1 ? '' : 's'} in ${secs}s over ${p.label}. ${more}${r.receipt}`.trim(),
        'ok',
      );
      // Sample ids for the presets, so they never run empty.
      const first = rows[0];
      if (first) {
        if (first.owner && /^[A-Za-z0-9_-]{43}$/.test(String(first.owner)))
          st.sampleWallet.value = String(first.owner);
        if (first.drive_id && isUuid(String(first.drive_id)))
          st.sampleDrive.value = String(first.drive_id);
      }
    } finally {
      busy = false;
    }
  }

  /** A question button: the period form, or the lookup form when the period is too big to scan. */
  async function ask(i: number): Promise<void> {
    const q = QUESTIONS[i];
    if (!q) return;
    st.asked.value = i;
    const p = st.currentPeriod();
    const total = s.bands.reduce((t, x) => t + x.records, 0);
    const wide = !!(
      p &&
      p.bands.every((b) => s.isRangeable(b)) &&
      p.size > CONFIG.askFirstPeriod &&
      q.wideSql &&
      st.pub.value.hasLookups
    );
    const sql = wide ? q.wideSql!.replaceAll('{TOTAL}', String(total)) : q.sql;
    st.sql.value = sql;
    await runQuery({
      title: q.title,
      caption: wide ? q.wideCaption!.replaceAll('{TOTAL_TEXT}', num(total)) : q.caption,
      confirmed: wide,
      sql,
    });
  }

  return { runQuery, ask, captionSegments };
}
