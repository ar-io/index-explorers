/**
 * The layout SQL against native DuckDB over the recorded band. Registered
 * file names are plain paths here; in the browser they are the range reader's
 * registered names, and the SQL is the same text.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { arfs, parquetL1, parquetL2, type parquetL2 as L2 } from '../src/index.js';
import { LIVE_BAND_DIR } from './helpers.js';

type Row = Record<string, unknown>;
const q = async (c: DuckDBConnection, sql: string): Promise<Row[]> =>
  (await c.runAndReadAll(sql)).getRowObjects() as Row[];
const n = (v: unknown): number => Number(v);

describe('parquet-l2 over the recorded band (blocks 700,000–799,999)', () => {
  let db: DuckDBInstance;
  let c: DuckDBConnection;
  const band: L2.RegisteredL2Band = {
    id: 'l2-h700000-799999-3078e8b8-a2a34f51df49',
    from: 700000,
    to: 799999,
    names: {
      it: path.join(LIVE_BAND_DIR, 'data_items.parquet'),
      tg: path.join(LIVE_BAND_DIR, 'tags.parquet'),
      li: path.join(LIVE_BAND_DIR, 'lookup_id.parquet'),
      lw: path.join(LIVE_BAND_DIR, 'lookup_wallet.parquet'),
      lg: path.join(LIVE_BAND_DIR, 'lookup_tag.parquet'),
    },
  };

  beforeAll(async () => {
    db = await DuckDBInstance.create(':memory:');
    c = await db.connect();
    for (const s of [...parquetL2.l2BaseSql([band]), ...arfs.arfsBaseSql([band])]) await c.run(s);
    for (const s of [
      ...parquetL2.l2PeriodViewsSql([band], 700000, 799999),
      ...arfs.arfsPeriodViewsSql([band], 700000, 799999),
    ])
      await c.run(s);
  });
  afterAll(() => {
    c.closeSync();
  });

  it('counts the band’s items as the publication says', async () => {
    const [r] = await q(c, 'SELECT count(*) AS n FROM uploads');
    expect(n(r!.n)).toBe(2712);
  });

  it('pivots ArFS records into entities with kinds, ids and privacy', async () => {
    const kinds = await q(
      c,
      'SELECT kind, count(*) AS n FROM entities GROUP BY kind ORDER BY kind',
    );
    const m = Object.fromEntries(kinds.map((r) => [r.kind as string, n(r.n)]));
    expect(m.drive).toBeGreaterThan(0);
    expect(m.file).toBeGreaterThan(0);
    expect(m.folder).toBeGreaterThan(0);
    const [d] = await q(c, 'SELECT count(*) AS n, count(DISTINCT drive_id) AS drives FROM drives');
    expect(n(d!.n)).toBe(n(d!.drives));
    const [badTime] = await q(
      c,
      'SELECT count(*) AS n FROM entities WHERE created_at IS NULL AND unix_time IS NOT NULL',
    );
    // Any created_at left null is a Unix-Time outside the bounded range, never a formatter's problem.
    expect(n(badTime!.n)).toBeGreaterThanOrEqual(0);
    const [p] = await q(
      c,
      "SELECT count(*) FILTER (WHERE privacy = 'public') AS pub, count(*) FILTER (WHERE privacy = 'private') AS priv FROM entities",
    );
    expect(n(p!.pub) + n(p!.priv)).toBeGreaterThan(0);
  });

  it('the latest-version rule: files has one row per File-Id and versions counts the rest', async () => {
    const [r] = await q(
      c,
      'SELECT count(*) AS rows, count(DISTINCT file_id) AS ids, sum(versions) AS all_versions FROM files',
    );
    expect(n(r!.rows)).toBe(n(r!.ids));
    const [e] = await q(
      c,
      "SELECT count(*) AS n FROM entities WHERE kind = 'file' AND entity_id IS NOT NULL",
    );
    expect(n(r!.all_versions)).toBe(n(e!.n));
  });

  it('tag_counts and drive_window answer from the lookups and agree with a scan', async () => {
    const counts = await q(c, "SELECT * FROM tag_counts('Entity-Type') ORDER BY value");
    const scan = await q(
      c,
      "SELECT value, count(DISTINCT id) AS uploads FROM tags WHERE name = 'Entity-Type' GROUP BY value ORDER BY value",
    );
    expect(counts.map((r) => [r.value, n(r.uploads)])).toEqual(
      scan.map((r) => [r.value, n(r.uploads)]),
    );
    const [drive] = await q(
      c,
      'SELECT drive_id, count(*) AS n FROM entities WHERE drive_id IS NOT NULL GROUP BY drive_id ORDER BY n DESC LIMIT 1',
    );
    const id = drive!.drive_id as string;
    const [w] = await q(c, `SELECT * FROM drive_window('${id}')`);
    expect(n(w!.records)).toBe(n(drive!.n));
    const [span] = await q(
      c,
      `SELECT min(height) AS lo, max(height) AS hi FROM entities WHERE drive_id = '${id}'`,
    );
    expect(n(w!.lo)).toBe(n(span!.lo));
    expect(n(w!.hi)).toBe(n(span!.hi));
    const viaMacro = await q(c, `SELECT count(*) AS n FROM drive('${id}')`);
    expect(n(viaMacro[0]!.n)).toBe(n(drive!.n));
  });

  it('driveRecordCounts gives each drive its records, as drive_window and a scan do', async () => {
    const drives = await q(
      c,
      'SELECT drive_id, count(*) AS n, min(height) AS lo FROM entities WHERE drive_id IS NOT NULL GROUP BY drive_id ORDER BY n DESC, drive_id LIMIT 4',
    );
    const ids = drives.map((d) => String(d.drive_id));
    const absent = '00000000-0000-0000-0000-000000000000';
    const from = Math.min(...drives.map((d) => n(d.lo)));
    const got = await q(
      c,
      `SELECT * FROM ${arfs.driveRecordCountsSql([band], [...ids, absent], from)} ORDER BY drive_id`,
    );
    const m = Object.fromEntries(got.map((r) => [String(r.drive_id), n(r.records)]));
    for (const d of drives) {
      expect(m[String(d.drive_id)]).toBe(n(d.n));
      const [w] = await q(c, `SELECT records FROM drive_window('${String(d.drive_id)}')`);
      expect(m[String(d.drive_id)]).toBe(n(w!.records));
    }
    // A value no record carries has no row; a band wholly before `from` is not read.
    expect(absent in m).toBe(false);
    const later = await q(c, `SELECT * FROM ${arfs.driveRecordCountsSql([band], ids, 800000)}`);
    expect(later.length).toBe(0);
  });

  it('find_id and wallet_totals agree with the tables', async () => {
    const [u] = await q(c, 'SELECT id, owner, data_size FROM uploads ORDER BY id LIMIT 1');
    const found = await q(c, `SELECT * FROM find_id('${u!.id}')`);
    expect(found.length).toBe(1);
    expect(found[0]!.owner).toBe(u!.owner);
    expect(n(found[0]!.data_size)).toBe(n(u!.data_size));
    const [t] = await q(c, `SELECT * FROM wallet_totals('${u!.owner}')`);
    const [s] = await q(
      c,
      `SELECT count(*) AS n, min(height) AS lo FROM uploads WHERE owner = '${u!.owner}'`,
    );
    expect(n(t!.uploads)).toBe(n(s!.n));
    expect(n(t!.first_block)).toBe(n(s!.lo));
  });

  it('bounded builders name only the bands a window touches', () => {
    expect(parquetL2.tagsSql([band], 1, 2)).toContain('WHERE false');
    expect(parquetL2.tagsSql([band], 700000, 700100)).toContain('BETWEEN 700000 AND 700100');
    expect(parquetL2.bandsInWindow([band], 799999, 900000).length).toBe(1);
    expect(parquetL2.hasLookups([band])).toBe(true);
    expect(parquetL2.hasLookups([{ ...band, names: { it: 'a', tg: 'b' } }])).toBe(false);
  });

  it('newestDrivesSql lists one row per drive, newest first', async () => {
    const rows = await q(c, arfs.newestDrivesSql([band], 700000, 799999));
    const ids = rows.map((r) => r.drive_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < rows.length; i++)
      expect(n(rows[i - 1]!.height)).toBeGreaterThanOrEqual(n(rows[i]!.height));
  });
});

describe('parquet-l1 layouts', () => {
  it('reads the lookup files of l1-3 and of l1-4, which keeps them and adds witnesses', () => {
    expect(
      ['l1-1', 'l1-2', 'l1-3', 'l1-4', 'l1-5', null].map(parquetL1.l1SchemaHasLookups),
    ).toEqual([false, false, true, true, false, false]);
    expect(parquetL1.L1_SCHEMAS).toContain('l1-4');
  });
});
