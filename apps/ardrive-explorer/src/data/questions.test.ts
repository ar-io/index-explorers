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
