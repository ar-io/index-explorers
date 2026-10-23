/**
 * Reading ahead over the recorded band: the column chunks named are the ones
 * holding the rows a lookup or a window needs, and no others; and the ranges
 * are joined and split as the parallel reads want them.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { engineReads, KEY_MACROS, parquetL2, readAheadSql, splitRanges } from '../src/index.js';
import { LIVE_BAND_DIR } from './helpers.js';

type Row = Record<string, unknown>;
const q = async (c: DuckDBConnection, sql: string): Promise<Row[]> =>
  (await c.runAndReadAll(sql)).getRowObjects() as Row[];
const n = (v: unknown): number => Number(v);

const band: parquetL2.RegisteredL2Band = {
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

/** The row groups (by id) of a file that hold the rows a query selects. */
async function rowGroupsOf(c: DuckDBConnection, file: string, where: string): Promise<number[]> {
  const sizes = await q(
    c,
    `SELECT DISTINCT row_group_id, row_group_num_rows FROM parquet_metadata('${file}') ORDER BY 1`,
  );
  const ends: number[] = [];
  let t = 0;
  for (const s of sizes) ends.push((t += n(s.row_group_num_rows)));
  const rows = await q(
    c,
    `SELECT file_row_number AS r FROM read_parquet('${file}', file_row_number = true) WHERE ${where}`,
  );
  return [...new Set(rows.map((x) => ends.findIndex((e) => n(x.r) < e)))].sort((a, b) => a - b);
}

/** The row groups a read ahead's ranges cover, by the column chunks' offsets. */
async function coveredGroups(c: DuckDBConnection, file: string, sql: string): Promise<number[]> {
  const ranges = await q(c, sql);
  const chunks = await q(
    c,
    `SELECT row_group_id, data_page_offset AS o FROM parquet_metadata('${file}')`,
  );
  const hit = chunks.filter((ch) =>
    ranges.some((r) => n(ch.o) >= n(r.start) && n(ch.o) < n(r.start) + n(r.len)),
  );
  return [...new Set(hit.map((h) => n(h.row_group_id)))].sort((a, b) => a - b);
}

describe('read ahead over the recorded band', () => {
  let db: DuckDBInstance;
  let c: DuckDBConnection;
  beforeAll(async () => {
    db = await DuckDBInstance.create(':memory:');
    c = await db.connect();
    for (const s of KEY_MACROS) await c.run(s);
  });
  afterAll(() => c.closeSync());

  it('a tag lookup names the row groups holding the pair, and each of its columns', async () => {
    const lg = band.names.lg!;
    const [pair] = await q(
      c,
      `SELECT CAST(value AS VARCHAR) AS v FROM read_parquet('${lg}') WHERE name = CAST('Drive-Id' AS BLOB) ORDER BY txs DESC LIMIT 1`,
    );
    const drive = String(pair!.v);
    const plan = parquetL2.tagLookupReadAhead([band], 'Drive-Id', drive);
    const sql = readAheadSql(plan);
    const need = await rowGroupsOf(c, lg, `name8 = hkey('Drive-Id') AND val8 = hkey('${drive}')`);
    expect(need.length).toBeGreaterThan(0);
    const got = await coveredGroups(c, lg, sql);
    for (const g of need) expect(got).toContain(g);
    const [total] = await q(
      c,
      `SELECT count(DISTINCT row_group_id) AS n FROM parquet_metadata('${lg}')`,
    );
    // Only what the statistics allow, not the file.
    if (n(total!.n) > 2) expect(got.length).toBeLessThan(n(total!.n));
    // Each column of each row group kept, and the key columns' bloom filters there.
    const blooms = await q(
      c,
      `SELECT bloom_filter_offset AS at FROM parquet_metadata('${lg}')
       WHERE row_group_id IN (${got.join(',')}) AND path_in_schema IN ('name8', 'val8') AND bloom_filter_offset IS NOT NULL`,
    );
    const ranges = await q(c, sql);
    expect(ranges.length).toBe(got.length * plan.columns!.length + blooms.length);
    for (const b of blooms) expect(ranges.some((r) => n(r.start) === n(b.at))).toBe(true);
  });

  it('a window names the row groups its heights touch in items and tags', async () => {
    for (const plan of parquetL2.windowReadAhead([band], 700000, 700400)) {
      const file = plan.files[0]!;
      const need = await rowGroupsOf(c, file, 'height BETWEEN 700000 AND 700400');
      const got = await coveredGroups(c, file, readAheadSql(plan));
      for (const g of need) expect(got).toContain(g);
      const [total] = await q(
        c,
        `SELECT count(DISTINCT row_group_id) AS n FROM parquet_metadata('${file}')`,
      );
      if (n(total!.n) > 2) expect(got.length).toBeLessThan(n(total!.n));
    }
    expect(parquetL2.windowReadAhead([band], 1, 2).every((p) => p.files.length === 0)).toBe(true);
  });

  it('splits a long read on aligned boundaries so it goes out in parallel', () => {
    expect(splitRanges([{ file: 'a', start: 100, end: 2500 }], 1024)).toEqual([
      { file: 'a', start: 100, end: 1024 },
      { file: 'a', start: 1024, end: 2048 },
      { file: 'a', start: 2048, end: 2500 },
    ]);
  });

  it('reads ahead what the engine reads, as logged from DuckDB-WASM 1.30', () => {
    // tags.parquet of band 1,500,000–1,599,999, opening a 20,000-record drive:
    // the engine asked for 85344256 onwards in blocks of 16 KiB, 64 KiB,
    // 256 KiB, 1, 4, 16 and 16 MiB, ending at 124485631, for chunks ending at
    // 108549626.
    expect(engineReads([{ start: 85351301, end: 108549627 }], 167804719)).toEqual([
      [85344256, 124485632],
    ]);
    // data_items.parquet, the same open: 88293376 to 127434751.
    expect(engineReads([{ start: 88299410, end: 123521438 }], 173679016)).toEqual([
      [88293376, 127434752],
    ]);
    // lookup_tag.parquet of the same band, the drive's Drive-Id: two row
    // groups 180 KiB apart, past the first head's buffer, so a second head
    // starts at 16 KiB again: 48971776–49315839, then 49496064–50888703.
    expect(
      engineReads(
        [
          { start: 48975000, end: 49300000 },
          { start: 49500000, end: 49900000 },
        ],
        57196658,
      ),
    ).toEqual([
      [48971776, 49315840],
      [49496064, 50888704],
    ]);
    // A gap the buffer already holds is read straight through.
    expect(
      engineReads(
        [
          { start: 0, end: 2_000_000 },
          { start: 2_100_000, end: 3_000_000 },
        ],
        50_000_000,
      ),
    ).toEqual([[0, 5_586_944]]);
    // A footer read: from a 16 KiB boundary, never past the end of the file.
    expect(engineReads([{ start: 20033955, end: 20099491 }], 20099491)).toEqual([
      [20021248, 20099491],
    ]);
    // Far apart: two runs, each from 16 KiB again.
    expect(
      engineReads(
        [
          { start: 0, end: 100 },
          { start: 1_000_000, end: 1_000_100 },
        ],
        5_000_000,
      ),
    ).toEqual([
      [0, 16384],
      [999424, 1015808],
    ]);
  });
});
