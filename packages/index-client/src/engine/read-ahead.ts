/**
 * Reading ahead. DuckDB-WASM reads synchronously, one range at a time, so a
 * query over many files waits on each round trip in turn: sixteen bands'
 * lookups cost sixteen footers and sixteen column reads back to back. Here
 * the page asks the range reader for those same bytes at once, in parallel;
 * the reader checks every piece against the signed torrent as always and
 * keeps it, so the query that follows is served from what was checked.
 *
 * Nothing read ahead is trusted more than before: it is the same worker, the
 * same pieces and the same checks. A read ahead that fails is not an answer
 * either; the query that follows reads (and refuses) the bytes itself.
 */
import type { Engine } from './engine.js';

/** Some Parquet files' row groups worth reading before a query, and the columns it reads. */
export interface ReadAhead {
  /** Registered file names. */
  files: readonly string[];
  /**
   * A row group is kept when every bound overlaps the statistics of its
   * column: `[min, max]` meets `[lo, hi]`. `lo` and `hi` are SQL expressions,
   * compared as HUGEINT, so `hkey('Drive-Id')` works as well as a height.
   * A row group without statistics is kept.
   */
  keep: readonly { column: string; lo: string; hi: string }[];
  /** The columns the query reads; null for every column of the row groups kept. */
  columns: readonly string[] | null;
}

/** A byte range of one file, end exclusive. */
export interface FileRange {
  file: string;
  start: number;
  end: number;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The column chunks a read ahead names, from the files' footers:
 * `file_name, start, len`, ordered by file and offset. For a bound on one
 * value (`lo` and `hi` the same), the column's bloom filters in the kept row
 * groups too: the engine checks them before it reads a row group.
 */
export function readAheadSql(ra: ReadAhead): string {
  const files = `parquet_metadata([${ra.files.map(lit).join(',')}])`;
  const points = ra.keep.filter((k) => k.lo === k.hi).map((k) => k.column);
  const bounds = ra.keep.length
    ? ra.keep
        .map(
          (k) => `WHEN col = ${lit(k.column)} THEN coalesce(
            TRY_CAST(min_v AS HUGEINT) <= CAST(${k.hi} AS HUGEINT) AND TRY_CAST(max_v AS HUGEINT) >= CAST(${k.lo} AS HUGEINT), true)`,
        )
        .join(' ')
    : '';
  return `WITH m AS (
      SELECT file_name, row_group_id, path_in_schema AS col, stats_min_value AS min_v, stats_max_value AS max_v,
        CASE WHEN coalesce(dictionary_page_offset, 0) > 0 THEN least(dictionary_page_offset, data_page_offset) ELSE data_page_offset END AS start,
        total_compressed_size AS len, bloom_filter_offset AS bloom_at, bloom_filter_length AS bloom_len
      FROM ${files}),
    keep AS (
      SELECT file_name, row_group_id FROM m GROUP BY ALL
      HAVING bool_and(CASE ${bounds} ELSE true END))
    SELECT * FROM (
      SELECT m.file_name, m.start::BIGINT AS start, m.len::BIGINT AS len
      FROM m SEMI JOIN keep USING (file_name, row_group_id)
      ${ra.columns ? `WHERE m.col IN (${ra.columns.map(lit).join(',')})` : ''}
      ${
        points.length
          ? `UNION ALL
      SELECT m.file_name, m.bloom_at::BIGINT, m.bloom_len::BIGINT
      FROM m SEMI JOIN keep USING (file_name, row_group_id)
      WHERE m.col IN (${points.map(lit).join(',')}) AND m.bloom_at IS NOT NULL AND m.bloom_len > 0`
          : ''
      })
    ORDER BY 1, 2`;
}

/**
 * Each range cut into parts of at most `cap` bytes, so one long stretch is
 * read in parallel too. The cuts fall on multiples of `cap`, a power of two:
 * so on piece boundaries, and no piece is fetched by two parts at once.
 */
export const splitRanges = (ranges: readonly FileRange[], cap: number): FileRange[] =>
  ranges.flatMap((r) => {
    const parts: FileRange[] = [];
    for (let s = r.start; s < r.end; s = (Math.floor(s / cap) + 1) * cap)
      parts.push({ file: r.file, start: s, end: Math.min(r.end, (Math.floor(s / cap) + 1) * cap) });
    return parts;
  });

const ENGINE_FIRST_READ = 16 * 1024;
const ENGINE_MAX_READ = 16 * 1024 * 1024;

/**
 * The bytes the engine fetches to read these ranges of one file of `size`.
 * DuckDB-WASM (1.30, engine.lock.json; lib/include/duckdb/web/io/
 * readahead_buffer.h) reads in 16 KiB blocks, and a read that starts exactly
 * where its buffer ends is sped up four times, up to 16 MiB: 16 KiB, 64 KiB,
 * 256 KiB, 1 MiB, 4 MiB, 16 MiB, 16 MiB. A range inside what is buffered is
 * served from it; one past it starts again at 16 KiB. So the last block runs
 * past the end, by up to 16 MiB. Reading ahead exactly that leaves the engine
 * nothing to wait for, at no more bytes than it reads on its own. Were the
 * engine to read differently, a read ahead would only help less; nothing
 * else changes.
 */
export function engineReads(
  ranges: readonly { start: number; end: number }[],
  size: number,
): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  let at = -1;
  let step = ENGINE_FIRST_READ;
  for (const r of [...ranges].sort((x, y) => x.start - y.start)) {
    if (at < 0 || r.start > at) {
      if (at >= 0) out.push([from, Math.min(at, size)]);
      from = at = Math.floor(r.start / ENGINE_FIRST_READ) * ENGINE_FIRST_READ;
      step = ENGINE_FIRST_READ;
    }
    while (at < r.end) {
      at += step;
      step = Math.min(step * 4, ENGINE_MAX_READ);
    }
  }
  if (at >= 0) out.push([from, Math.min(at, size)]);
  return out;
}

export interface ReadAheadOptions {
  /** Requests in flight at once. */
  concurrency?: number;
  /** The most one request asks for. */
  cap?: number;
  /**
   * The most read ahead in all; past it the query reads the rest itself. The
   * reader keeps 96 MB of checked pieces in memory (more on disk, checked
   * again when taken back), so a read ahead stays within that by default.
   */
  maxBytes?: number;
  /** Polled between requests: true once the page has moved on and the reads are no longer wanted. */
  stop?: () => boolean;
  fetch?: typeof fetch;
}

/** The last bytes of a Parquet file fetched first: its footer is almost always within them. */
const TAIL = 64 * 1024;

/**
 * Reads ahead what the plans name: every file's footer at once, then the
 * stretches the engine will read for the chosen column chunks, at once.
 * Returns the bytes asked for; never throws.
 */
export async function readAhead(
  engine: Engine,
  plans: readonly ReadAhead[],
  opts: ReadAheadOptions = {},
): Promise<{ bytes: number; requests: number }> {
  const f = opts.fetch ?? fetch;
  const concurrency = opts.concurrency ?? 16;
  let bytes = 0;
  let requests = 0;
  const get = async (r: FileRange, keep = false): Promise<Uint8Array | null> => {
    const at = engine.fileOf(r.file);
    if (!at || r.end <= r.start) return null;
    requests += 1;
    bytes += r.end - r.start;
    try {
      const res = await f(at.url, { headers: { Range: `bytes=${r.start}-${r.end - 1}` } });
      // The worker answers once every piece is checked and kept, so a body
      // that is not needed here is dropped unread.
      if (res.status !== 206 || !keep) {
        await res.body?.cancel();
        return null;
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  };
  const pool = async (ranges: FileRange[], each: (r: FileRange) => Promise<unknown>) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ranges.length) }, async () => {
        while (next < ranges.length && !opts.stop?.()) await each(ranges[next++]!);
      }),
    );
  };
  try {
    // Footers: the tail of each file, then whatever of the engine's read of
    // the footer the tail did not hold.
    const files = [...new Set(plans.flatMap((p) => p.files))].filter((n) => engine.fileOf(n));
    await pool(
      files.map((file) => {
        const size = engine.fileOf(file)!.size;
        return { file, start: Math.max(0, size - TAIL), end: size };
      }),
      async (r) => {
        const tail = await get(r, true);
        if (!tail || tail.length < 8) return;
        const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        const footer = v.getUint32(tail.length - 8, true) + 8;
        if (footer > r.end) return;
        const [[from]] = engineReads([{ start: r.end - footer, end: r.end }], r.end) as [
          [number, number],
        ];
        if (from < r.start) await get({ file: r.file, start: from, end: r.start });
      },
    );
    // The chunks the queries will read.
    const ranges: FileRange[] = [];
    for (const p of plans) {
      if (!p.files.length) continue;
      const t = await engine.query(readAheadSql(p));
      for (const row of t.toArray() as { file_name: string; start: bigint; len: bigint }[]) {
        const start = Number(row.start);
        ranges.push({ file: String(row.file_name), start, end: start + Number(row.len) });
      }
    }
    const budget = opts.maxBytes ?? 90 * 1024 * 1024;
    let planned = 0;
    const byFile = new Map<string, FileRange[]>();
    for (const r of ranges) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
    const spans = [...byFile].flatMap(([file, rs]) =>
      engineReads(rs, engine.fileOf(file)!.size).map(([start, end]) => ({ file, start, end })),
    );
    const within = splitRanges(spans, opts.cap ?? 2 * 1024 * 1024).filter(
      (r) => (planned += r.end - r.start) <= budget,
    );
    await pool(within, (r) => get(r));
  } catch {
    /* a read ahead is only ever a head start */
  }
  return { bytes, requests };
}
