/**
 * The `parquet-l1` layout (`l1-3`): every Arweave base-layer block and
 * transaction as Parquet, with tags, owners and three lookup files.
 *
 * SQL text over registered file names; the views a period defines are
 * `blocks`, `rawtx`, `txs` and `tags`, and the three macros with one meaning
 * and two implementations: `find_tx(id)`, `wallet_totals(address)` and
 * `tag_counts(name)`. When every band of the period carries lookup files they
 * read those; a period cut by date uses the tables, because a lookup
 * describes whole bands.
 */
import { KEY_MACROS, readList } from './keys.js';

export const L1_SCHEMAS = ['l1-1', 'l1-2', 'l1-3'];

export const L1_FILES = {
  tx: 'transactions.parquet',
  bl: 'blocks.parquet',
  tg: 'tags.parquet',
  lt: 'lookup_tx_id.parquet',
  lw: 'lookup_wallet.parquet',
  lg: 'lookup_tag.parquet',
} as const;
export type L1Kind = keyof typeof L1_FILES;
export const L1_TABLE_KINDS: L1Kind[] = ['tx', 'bl', 'tg'];
export const L1_LOOKUP_KINDS: L1Kind[] = ['lt', 'lw', 'lg'];

export interface RegisteredL1Band {
  id: string;
  from: number;
  to: number;
  names: Partial<Record<L1Kind, string>>;
}

export const L1_OBJECTS = {
  views: ['txs', 'blocks', 'rawtx', 'tags', 'lookup_tx_id', 'lookup_wallet', 'lookup_tag'],
  macros: ['find_tx', 'wallet_totals', 'tag_counts'],
};

export const l1DropSql = (): string[] => [
  ...L1_OBJECTS.views.map((v) => `DROP VIEW IF EXISTS ${v}`),
  ...L1_OBJECTS.macros.map((m) => `DROP MACRO TABLE IF EXISTS ${m}`),
];

const namesOf = (bands: readonly RegisteredL1Band[], kind: L1Kind): string[] =>
  bands.map((b) => b.names[kind]).filter((n): n is string => !!n);

export const l1HasLookups = (bands: readonly RegisteredL1Band[]): boolean =>
  bands.length > 0 && bands.every((b) => b.names.lt && b.names.lw && b.names.lg);

export interface L1PeriodOptions {
  /** Calendar bounds in epoch seconds: the period is cut by block time, then by the heights those give. */
  fromTime?: number;
  toTime?: number;
}

/**
 * The statements that open a period over `bands`. Two phases: `first`
 * defines `blocks` (cut by date when asked), after which the caller reads
 * `SELECT min(height), max(height) FROM blocks` and passes the heights to
 * `second`, which defines the rest with a plain height range so row-group
 * statistics prune every file.
 */
export function l1PeriodSql(bands: readonly RegisteredL1Band[], opts: L1PeriodOptions = {}) {
  const tx = namesOf(bands, 'tx');
  const bl = namesOf(bands, 'bl');
  const tg = namesOf(bands, 'tg');
  const bounds = [
    opts.fromTime != null ? `block_timestamp >= ${Math.floor(opts.fromTime)}` : null,
    opts.toTime != null ? `block_timestamp < ${Math.floor(opts.toTime)}` : null,
  ].filter((b): b is string => !!b);
  const dated = bounds.length > 0 && bl.length > 0;
  const first: string[] = [...KEY_MACROS];
  if (bl.length) {
    // A plain UTC TIMESTAMP, not to_timestamp()'s TIMESTAMPTZ: DuckDB-WASM
    // ships without ICU, so strftime and friends fail on a zoned value.
    first.push(`CREATE OR REPLACE VIEW blocks AS SELECT
          height, epoch_ms(block_timestamp * 1000) AS mined_at, tx_count, block_size,
          b64u(indep_hash) AS block_id
        FROM ${readList(bl)}${dated ? ' WHERE ' + bounds.join(' AND ') : ''}`);
  }
  const second = (lo: number, hi: number): string[] => {
    const inPeriod = dated ? ` WHERE height BETWEEN ${lo} AND ${hi}` : '';
    const out: string[] = [
      `CREATE OR REPLACE VIEW rawtx AS SELECT * FROM ${readList(tx)}${inPeriod}`,
    ];
    if (bl.length) {
      out.push(`CREATE OR REPLACE VIEW txs AS SELECT
          b64u(t.id) AS tx_id, t.height, bk.mined_at, b64u(t.owner_address) AS owner,
          b64u(t.target) AS target, t.data_size, t.content_type, t.quantity, t.reward,
          t.format, b64u(t.data_root) AS data_root
        FROM rawtx t ${dated ? 'JOIN' : 'LEFT JOIN'} blocks bk USING (height)`);
    } else {
      out.push(`CREATE OR REPLACE VIEW txs AS SELECT
          b64u(id) AS tx_id, height, NULL::TIMESTAMP AS mined_at, b64u(owner_address) AS owner,
          b64u(target) AS target, data_size, content_type, quantity, reward,
          format, b64u(data_root) AS data_root
        FROM rawtx`);
    }
    // A CAST never fails on bytes that are not UTF-8, where decode() would.
    if (tg.length) {
      out.push(`CREATE OR REPLACE VIEW tags AS SELECT
          b64u(id) AS tx_id, height, tag_index,
          CAST(tag_name AS VARCHAR) AS name, CAST(tag_value AS VARCHAR) AS value
        FROM ${readList(tg)}${inPeriod}`);
    }
    out.push(...l1LookupSql(bands, dated));
    return out;
  };
  return { first, second, dated, hasBlocks: bl.length > 0, hasTags: tg.length > 0 };
}

/** The three macros, over the lookups when the whole period has them, else the tables. */
export function l1LookupSql(bands: readonly RegisteredL1Band[], dated: boolean): string[] {
  const lt = namesOf(bands, 'lt');
  const lw = namesOf(bands, 'lw');
  const lg = namesOf(bands, 'lg');
  const tg = namesOf(bands, 'tg');
  const useLookups = !dated && l1HasLookups(bands);
  if (useLookups) {
    return [
      `CREATE OR REPLACE VIEW lookup_tx_id AS SELECT * FROM ${readList(lt)}`,
      `CREATE OR REPLACE VIEW lookup_wallet AS SELECT * FROM ${readList(lw)}`,
      `CREATE OR REPLACE VIEW lookup_tag AS SELECT * FROM ${readList(lg)}`,
      `CREATE OR REPLACE MACRO find_tx(i) AS TABLE
      SELECT * FROM txs WHERE height IN (SELECT height FROM lookup_tx_id WHERE id8 = key64(unb64u(i))) AND tx_id = i`,
      `CREATE OR REPLACE MACRO wallet_totals(a) AS TABLE
      SELECT count(*) FILTER (role = 0) AS sent, count(*) FILTER (role = 1) AS received,
             round(sum(data_size) FILTER (role = 0) / power(2,30), 3) AS gib_stored,
             min(height) AS first_block, max(height) AS last_block
      FROM lookup_wallet WHERE addr8 = key64(unb64u(a))`,
      `CREATE OR REPLACE MACRO tag_counts(n) AS TABLE
      SELECT CAST(value AS VARCHAR) AS value, sum(txs) AS transactions
      FROM lookup_tag WHERE name8 = hkey(n) AND name = CAST(n AS BLOB) GROUP BY ALL`,
    ];
  }
  const out = [
    `CREATE OR REPLACE MACRO find_tx(i) AS TABLE SELECT * FROM txs WHERE tx_id = i`,
    `CREATE OR REPLACE MACRO wallet_totals(a) AS TABLE
      SELECT count(*) FILTER (owner_address = unb64u(a)) AS sent, count(*) FILTER (target = unb64u(a)) AS received,
             round(sum(data_size) FILTER (owner_address = unb64u(a)) / power(2,30), 3) AS gib_stored,
             min(height) AS first_block, max(height) AS last_block
      FROM rawtx WHERE owner_address = unb64u(a) OR target = unb64u(a)`,
  ];
  if (tg.length)
    out.push(`CREATE OR REPLACE MACRO tag_counts(n) AS TABLE
        SELECT value, count(DISTINCT tx_id) AS transactions FROM tags WHERE name = n GROUP BY value`);
  return out;
}

/** A transaction at the heights the lookup gave, with its tags; the SQL a Find shows. */
export const txLookupSql = (id: string, heights: number[]): string =>
  `-- Found through this index's own lookup files, which point at block${heights.length === 1 ? '' : 's'} ${heights.join(', ')};\n` +
  `-- the row is read from the signed index there. No gateway was asked.\n` +
  `SELECT t.tx_id, t.height, t.mined_at, t.owner, t.target, t.data_size, t.content_type,\n` +
  `       (SELECT left(string_agg(g.name || '=' || g.value, '  ' ORDER BY g.tag_index), 400)\n` +
  `        FROM tags g WHERE g.height IN (${heights.join(', ')}) AND g.tx_id = t.tx_id) AS tags\n` +
  `FROM txs t\nWHERE t.height IN (${heights.join(', ')}) AND t.tx_id = '${id}';`;
