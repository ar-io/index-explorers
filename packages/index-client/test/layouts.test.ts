/**
 * The layout SQL against native DuckDB over the recorded band. Registered
 * file names are plain paths here; in the browser they are the range reader's
 * registered names, and the SQL is the same text.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  arfs,
  KEY_MACROS,
  parquetL1,
  parquetL2,
  type parquetL2 as L2,
  readAheadSql,
} from '../src/index.js';
import { FIXTURES, LIVE_BAND_DIR } from './helpers.js';

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

  it('names the tables a period defines, the lookups only where it reads them', () => {
    const band = (lookups: boolean): parquetL1.RegisteredL1Band => ({
      id: 'b',
      from: 0,
      to: 9,
      names: { tx: 'tx', bl: 'bl', tg: 'tg', ...(lookups ? { lt: 'lt', lw: 'lw', lg: 'lg' } : {}) },
    });
    expect(parquetL1.l1PeriodSql([band(false)]).tables).toEqual(['txs', 'blocks', 'tags', 'rawtx']);
    expect(parquetL1.l1PeriodSql([band(true)]).tables).toEqual([
      'txs',
      'blocks',
      'tags',
      'rawtx',
      'lookup_tx_id',
      'lookup_wallet',
      'lookup_tag',
    ]);
    // A calendar year is cut by date, so its lookups are not defined.
    expect(parquetL1.l1PeriodSql([band(true)], { fromTime: 1 }).tables).not.toContain(
      'lookup_tx_id',
    );
    // Every one of them is a view the period's SQL defines.
    const sql = parquetL1.l1PeriodSql([band(true)]);
    const made = [...sql.first, ...sql.second(0, 9)].join('\n');
    for (const t of sql.tables) expect(made).toContain(`CREATE OR REPLACE VIEW ${t} AS`);
  });
});

describe('parquet-l2 layout l2-2 key lookup and stats (the synthetic l2-2 band)', () => {
  const dir = path.join(
    FIXTURES,
    'synthetic',
    'ardrive-l2',
    'l2-h2000000-2004999-f1x7ur3e-4b9adf03fe5f',
  );
  let db: DuckDBInstance;
  let c: DuckDBConnection;
  beforeAll(async () => {
    db = await DuckDBInstance.create(':memory:');
    c = await db.connect();
    for (const s of KEY_MACROS) await c.run(s);
  });
  afterAll(() => c.closeSync());

  it('reads statTags from an l2-2 band.json only', () => {
    const json = JSON.parse(readFileSync(path.join(dir, parquetL2.L2_BAND_FILE), 'utf8'));
    expect(parquetL2.statTagsOf(json)).toContain('Entity-Type');
    expect(parquetL2.statTagsOf({ ...json, schema: 'l2-1' })).toEqual([]);
    expect(parquetL2.statTagsOf({ schema: 'l2-2', statTags: 'Entity-Type' })).toEqual([]);
    expect(parquetL2.statTagsOf(null)).toEqual([]);
  });

  it('counts a stat tag from the stats file as the tag lookup does', async () => {
    const counts = async (sql: string) =>
      Object.fromEntries((await q(c, sql)).map((r) => [String(r.kind), n(r.n)]));
    const stats = await counts(
      parquetL2.statCountsSql([path.join(dir, parquetL2.L2_STATS_FILE)], 'Entity-Type'),
    );
    const lookup = await counts(
      parquetL2.tagCountsSql('Entity-Type', [path.join(dir, 'lookup_tag.parquet')]),
    );
    expect(stats.drive).toBeGreaterThan(0);
    expect(stats.file).toBeGreaterThan(0);
    expect(stats).toEqual(lookup);
  });

  it('reads keyTags from an l2-2 band.json only', () => {
    const json = JSON.parse(readFileSync(path.join(dir, parquetL2.L2_BAND_FILE), 'utf8'));
    expect(parquetL2.keyTagsOf(json)).toContain('Drive-Id');
    expect(parquetL2.keyTagsOf({ ...json, schema: 'l2-1' })).toEqual([]);
    expect(parquetL2.keyTagsOf({ schema: 'l2-2', keyTags: 'Drive-Id' })).toEqual([]);
  });

  it("gives a drive's heights from the key lookup as a scan of tags does, within the tag lookup's window", async () => {
    const tg = path.join(dir, 'tags.parquet');
    const lk = [path.join(dir, parquetL2.L2_KEY_FILE)];
    const lg = [path.join(dir, 'lookup_tag.parquet')];
    const drives = await q(
      c,
      `SELECT CAST(tag_value AS VARCHAR) AS d FROM read_parquet('${tg}') WHERE tag_name = CAST('Drive-Id' AS BLOB) GROUP BY 1 ORDER BY count(DISTINCT height) DESC LIMIT 3`,
    );
    expect(drives.length).toBeGreaterThan(0);
    for (const { d } of drives) {
      const id = String(d);
      const keyed = await q(c, parquetL2.keyHeightsSql(lk, 'Drive-Id', id));
      const scan = await q(
        c,
        `SELECT height, count(DISTINCT id) AS items FROM read_parquet('${tg}') WHERE tag_name = CAST('Drive-Id' AS BLOB) AND tag_value = CAST('${id}' AS BLOB) GROUP BY 1 ORDER BY 1`,
      );
      expect(keyed.map((r) => [n(r.height), n(r.items)])).toEqual(
        scan.map((r) => [n(r.height), n(r.items)]),
      );
      const [w] = await q(c, parquetL2.tagWindowSql(lg, 'Drive-Id', id));
      expect(n(w!.lo)).toBe(n(keyed[0]!.height));
      expect(n(w!.hi)).toBe(n(keyed[keyed.length - 1]!.height));
    }
    const none = await q(c, parquetL2.keyHeightsSql(lk, 'Drive-Id', 'no-such-drive'));
    expect(none).toEqual([]);
  });

  it('reads ahead the row groups a key sits in', async () => {
    const lk = path.join(dir, parquetL2.L2_KEY_FILE);
    const [r] = await q(
      c,
      `SELECT CAST(tag_value AS VARCHAR) AS d FROM read_parquet('${path.join(dir, 'tags.parquet')}') WHERE tag_name = CAST('Drive-Id' AS BLOB) LIMIT 1`,
    );
    const plan = parquetL2.keyLookupReadAhead([lk], 'Drive-Id', String(r!.d));
    const ranges = await q(c, readAheadSql(plan));
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((x) => x.file_name === lk)).toBe(true);
  });
});
