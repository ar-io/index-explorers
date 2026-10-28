import { arfs, parquetL2, sourcesOf } from '@ar-io/index-client';
import { describe, expect, it } from 'vitest';

import { askedFor, columnLabel, PRESETS, presetSql, QUESTIONS } from './questions.js';

describe('a question or preset found again from its SQL', () => {
  it('finds each question by its period form and its all-history form', () => {
    QUESTIONS.forEach((q, i) => {
      expect(askedFor(q.sql)).toEqual({
        title: q.title,
        caption: q.caption,
        question: i,
        wide: false,
      });
      if (q.wideSql)
        expect(askedFor(q.wideSql.replaceAll('{TOTAL}', '123456'))).toMatchObject({
          title: q.title,
          question: i,
          wide: true,
        });
    });
  });

  it('finds a preset with its ids filled in, and ignores spacing and a trailing semicolon', () => {
    const one = PRESETS.find((p) => p.label === 'One drive')!;
    const sql = presetSql(one, null, '05b211dd-ae1e-44ef-b055-2e102933e4e8');
    expect(askedFor(sql)?.title).toBe('One drive');
    expect(askedFor(`  ${QUESTIONS[0]!.sql.replace(/\n/g, '\n   ')}  `)?.question).toBe(0);
  });

  it('knows nothing of SQL it did not write, nor of a preset whose filled slot hides more SQL', () => {
    expect(askedFor('SELECT 1')).toBeNull();
    const one = PRESETS.find((p) => p.label === 'One drive')!;
    expect(askedFor(one.sql.replace('{DRIVE}', "x') UNION SELECT 1 --"))).toBeNull();
  });

  it('labels the SQL column names the questions use', () => {
    for (const k of ['content_type', 'drives_touched', 'mib', 'created_at']) {
      expect(columnLabel(k)).not.toBe(k);
      expect(columnLabel(k)).not.toMatch(/_/);
    }
    expect(columnLabel('something_else')).toBe('something_else');
  });
});

describe('what the questions read', () => {
  const keyed = new Set([...parquetL2.L2_KEYED_SOURCES, ...arfs.ARFS_KEYED_SOURCES]);

  it('each wide form answers from the lookups by key alone, so it is labelled the whole index', () => {
    for (const q of QUESTIONS.filter((x) => x.wideSql)) {
      const src = sourcesOf(q.wideSql!.replaceAll('{TOTAL}', '1'));
      expect(src, q.title).not.toBeNull();
      expect(src!.length, q.title).toBeGreaterThan(0);
      expect(
        src!.every((n) => keyed.has(n)),
        q.title,
      ).toBe(true);
    }
  });

  it('each period form scans the period, so a wide period still asks first', () => {
    for (const q of QUESTIONS) {
      const src = sourcesOf(q.sql);
      expect(src && src.every((n) => keyed.has(n)), q.title).toBe(false);
    }
  });

  it('a grouping by day or month names the undated rows rather than leaving a blank', () => {
    for (const sql of [...QUESTIONS.map((q) => q.sql), ...PRESETS.map((p) => p.sql)])
      if (/strftime\(date_trunc/.test(sql))
        expect(sql).toMatch(/coalesce\(strftime\(.*'\(no date\)'\)/);
  });
});

describe('captions', () => {
  it('fill {RANGE} ("from … to …") mid-sentence, never where a sentence starts', () => {
    for (const q of QUESTIONS) expect(q.caption, q.title).not.toMatch(/(^|[.!?]\s*)\{RANGE\}/);
  });
});
