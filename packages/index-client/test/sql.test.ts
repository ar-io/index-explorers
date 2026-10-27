/**
 * What a statement reads, as the ArDrive page decides on a warning and on
 * the period label; and the upload time a Unix-Time tag gives.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';

import { arfs, parquetL2, sourcesOf } from '../src/index.js';

describe('sourcesOf', () => {
  it('reads the lookup macros, less the statement’s own CTEs', () => {
    expect(
      sourcesOf("SELECT value, uploads FROM tag_counts('App-Name') ORDER BY uploads DESC LIMIT 5;"),
    ).toEqual(['tag_counts']);
    expect(
      sourcesOf(
        "WITH c AS (SELECT sum(uploads) AS private FROM tag_counts('Cipher'))\nSELECT 'private' AS how, private AS uploads FROM c\nUNION ALL\nSELECT 'public', 10 - private FROM c;",
      ),
    ).toEqual(['tag_counts']);
  });

  it('a column named like a view is not a source', () => {
    expect(sourcesOf("SELECT sum(uploads) AS n FROM tag_counts('Entity-Type')")).toEqual([
      'tag_counts',
    ]);
  });

  it('finds every source: joins, aliases, FROM lists, subqueries, recursive CTEs', () => {
    expect(sourcesOf('SELECT * FROM uploads u LEFT JOIN entities e USING (id, height)')).toEqual([
      'uploads',
      'entities',
    ]);
    expect(sourcesOf("SELECT * FROM wallet_totals('x') w, uploads")).toEqual([
      'wallet_totals',
      'uploads',
    ]);
    expect(
      sourcesOf('SELECT * FROM (SELECT owner FROM uploads) t JOIN LATERAL (SELECT 1) x ON true'),
    ).toEqual(['uploads']);
    expect(
      sourcesOf(
        'WITH RECURSIVE path(folder_id, depth) AS (\n  SELECT folder_id, 1 FROM folders WHERE parent_folder_id IS NULL\n  UNION ALL\n  SELECT f.folder_id, p.depth + 1 FROM folders f JOIN path p ON f.parent_folder_id = p.folder_id\n)\nSELECT depth FROM path',
      ),
    ).toEqual(['folders', 'folders']);
    expect(sourcesOf("SELECT * FROM drive('d') WHERE kind = 'file'")).toEqual(['drive']);
  });

  it('ignores FROM inside extract, comments and strings', () => {
    expect(
      sourcesOf(
        "-- FROM uploads\nSELECT extract(year FROM created_at), 'FROM tags' FROM tag_counts('x') /* JOIN tags */",
      ),
    ).toEqual(['tag_counts']);
  });

  it('is unsure of quoted names, schemas and file paths', () => {
    expect(sourcesOf('SELECT * FROM "uploads"')).toBeNull();
    expect(sourcesOf('SELECT * FROM main.uploads')).toBeNull();
    expect(sourcesOf("SELECT * FROM 'x.parquet'")).toBeNull();
  });

  it('every source the layouts call keyed is also whole-index', () => {
    const whole = new Set([...parquetL2.L2_WHOLE_SOURCES, ...arfs.ARFS_WHOLE_SOURCES]);
    for (const k of [...parquetL2.L2_KEYED_SOURCES, ...arfs.ARFS_KEYED_SOURCES])
      expect(whole.has(k)).toBe(true);
  });
});

describe('CREATED_AT', () => {
  it('converts seconds and milliseconds, and leaves anything else empty', async () => {
    const db = await DuckDBInstance.create(':memory:');
    const c = await db.connect();
    const rows = (
      await c.runAndReadAll(
        `SELECT x, strftime(${parquetL2.CREATED_AT('x')}, '%Y-%m-%d %H:%M:%S') AS t
         FROM (VALUES (1, 1761552000), (2, 1761552000123), (3, 12), (4, NULL), (5, 99999999999999)) v(k, x) ORDER BY k`,
      )
    ).getRowObjects();
    expect(rows.map((r) => r.t)).toEqual([
      '2025-10-27 08:00:00',
      '2025-10-27 08:00:00',
      null,
      null,
      null,
    ]);
    c.closeSync();
  });
});
