/**
 * The `parquet-l2` layout (`l2-1`): the ANS-104 data items one **selection**
 * takes (any app's, by a tag name and value prefix), as Parquet bands on the
 * L1 height grid, with their tags, owners, locations and three lookup files.
 *
 * Everything here is generic to the layout: the files a band carries, the
 * bounded readers over items and tags, the `uploads` view, and the macros
 * every selection supports (`find_id`, `wallet_totals`, `tag_counts`). What a
 * selection's items *mean*, such as ArDrive's ArFS records, is a layer on top:
 * see `arfs.ts` for ArDrive's, and docs/new-l2-index.md for writing another.
 *
 * Every reader is bounded by height so the Parquet reader prunes row groups,
 * and a view over a window names only the files of the bands that window
 * touches: a view over every band would read every file's footer on the
 * first query.
 */
import type { ReadAhead } from '../engine/read-ahead.js';
import { sq } from '../util/format.js';
import { KEY_MACROS, readList } from './keys.js';

export const L2_SCHEMA = 'l2-1';

/** The files of a band this layout reads, and the short kind each is registered under. */
export const L2_FILES = {
  it: 'data_items.parquet',
  tg: 'tags.parquet',
  li: 'lookup_id.parquet',
  lw: 'lookup_wallet.parquet',
  lg: 'lookup_tag.parquet',
} as const;
export type L2Kind = keyof typeof L2_FILES;
export const L2_TABLE_KINDS: L2Kind[] = ['it', 'tg'];
export const L2_LOOKUP_KINDS: L2Kind[] = ['li', 'lw', 'lg'];

/** One band's registered DuckDB file names, by kind, with its heights. */
export interface RegisteredL2Band {
  id: string;
  from: number;
  to: number;
  names: Partial<Record<L2Kind, string>>;
}

/** The views and macros this layout creates, for a clean drop. */
export const L2_OBJECTS = {
  views: ['uploads', 'tags', 'items_all', 'tags_all', 'lookup_id', 'lookup_wallet', 'lookup_tag'],
  macros: [
    'items_between',
    'owners_between',
    'uploads_between',
    'wallet_totals',
    'find_id',
    'tag_counts',
  ],
};

export const l2DropSql = (): string[] => [
  ...L2_OBJECTS.views.map((v) => `DROP VIEW IF EXISTS ${v}`),
  ...L2_OBJECTS.macros.map((m) => `DROP MACRO TABLE IF EXISTS ${m}`),
];

export const namesOf = (bands: readonly RegisteredL2Band[], kind: L2Kind): string[] =>
  bands.map((b) => b.names[kind]).filter((n): n is string => !!n);

/** The bands a height window touches. */
export const bandsInWindow = (
  bands: readonly RegisteredL2Band[],
  lo: number,
  hi: number,
): RegisteredL2Band[] => bands.filter((b) => b.to >= lo && b.from <= hi);

/** Whether every band carries its three lookup files, so the lookup paths can be used. */
export const hasLookups = (bands: readonly RegisteredL2Band[]): boolean =>
  bands.length > 0 && bands.every((b) => b.names.li && b.names.lw && b.names.lg);

const EMPTY_TAGS = `(SELECT NULL::BLOB AS id, NULL::UBIGINT AS height, NULL::VARCHAR AS name, NULL::VARCHAR AS value WHERE false)`;
const EMPTY_ITEMS = `(SELECT NULL::BLOB AS id, NULL::UBIGINT AS height, NULL::BLOB AS owner_address, NULL::BLOB AS root_transaction_id, NULL::UBIGINT AS data_size, NULL::VARCHAR AS content_type WHERE false)`;

/** Plaintext tags of a window: `id, height, name, value`. */
export function tagsSql(bands: readonly RegisteredL2Band[], lo: number, hi: number): string {
  const f = namesOf(bandsInWindow(bands, lo, hi), 'tg');
  if (!f.length) return EMPTY_TAGS;
  return `(SELECT id, height, CAST(tag_name AS VARCHAR) AS name, CAST(tag_value AS VARCHAR) AS value FROM ${readList(f)} WHERE height BETWEEN ${lo} AND ${hi})`;
}

/**
 * Items of a window, one row per (id, height). `data_items` holds a row per
 * place an item sits, so a few items appear twice; GROUP BY takes one, and no
 * window function is used so the height filter reaches the Parquet reader.
 * `slim` reads two columns instead of five: about half the bytes of a row group.
 */
export function itemsSql(
  bands: readonly RegisteredL2Band[],
  lo: number,
  hi: number,
  slim: boolean,
): string {
  const f = namesOf(bandsInWindow(bands, lo, hi), 'it');
  if (!f.length) return EMPTY_ITEMS;
  const cols = slim
    ? 'any_value(owner_address) AS owner_address, any_value(data_size) AS data_size'
    : 'any_value(owner_address) AS owner_address, any_value(root_transaction_id) AS root_transaction_id, any_value(data_size) AS data_size, any_value(content_type) AS content_type';
  return `(SELECT id, height, ${cols} FROM ${readList(f)} WHERE height BETWEEN ${lo} AND ${hi} GROUP BY id, height)`;
}

/**
 * What reading a window's items and tags (`itemsSql` slim, `tagsSql`) will
 * fetch: the row groups its heights touch, in the files of the bands it touches.
 */
export function windowReadAhead(
  bands: readonly RegisteredL2Band[],
  lo: number,
  hi: number,
): ReadAhead[] {
  const inWindow = bandsInWindow(bands, lo, hi);
  const keep = [{ column: 'height', lo: String(lo), hi: String(hi) }];
  return [
    {
      files: namesOf(inWindow, 'it'),
      keep,
      columns: ['id', 'height', 'owner_address', 'data_size'],
    },
    { files: namesOf(inWindow, 'tg'), keep, columns: ['id', 'height', 'tag_name', 'tag_value'] },
  ];
}

/**
 * What finding one tag pair in `lookup_tag` will fetch, over every band: the
 * row groups whose key statistics can hold the pair (the file is sorted by them).
 */
export function tagLookupReadAhead(
  bands: readonly RegisteredL2Band[],
  name: string,
  value: string,
): ReadAhead {
  const n = `hkey(${sq(name)})`;
  const v = `hkey(${sq(value)})`;
  return {
    files: namesOf(bands, 'lg'),
    keep: [
      { column: 'name8', lo: n, hi: n },
      { column: 'val8', lo: v, hi: v },
    ],
    columns: ['name8', 'val8', 'name', 'value', 'txs', 'first_height', 'last_height'],
  };
}

/**
 * A Unix-Time stamped in milliseconds (some apps did) would throw in
 * Date#toISOString; the value is bounded here so no formatter ever sees it.
 */
export const CREATED_AT = (expr: string): string =>
  `CASE WHEN ${expr} BETWEEN 1000000000 AND 4000000000 THEN epoch_ms(${expr} * 1000) END`;

/**
 * Every upload in a window with the app that made it and the time it stamped.
 * `is_record` is true for an item carrying an `Entity-Type` tag (an ArFS
 * record); other selections may ignore it.
 */
export function uploadsSql(bands: readonly RegisteredL2Band[], lo: number, hi: number): string {
  return `(WITH t AS (
      SELECT height, id,
        max(CASE WHEN name = 'App-Name' THEN value END) AS app,
        max(CASE WHEN name = 'App-Version' THEN value END) AS app_version,
        max(CASE WHEN name = 'Unix-Time' THEN try_cast(value AS BIGINT) END) AS unix_time,
        max(CASE WHEN name = 'Cipher' THEN value END) AS cipher,
        bool_or(name = 'Entity-Type') AS is_record
      FROM ${tagsSql(bands, lo, hi)} WHERE name IN ('App-Name','App-Version','Unix-Time','Cipher','Entity-Type')
      GROUP BY height, id)
    SELECT b64u(i.id) AS id, i.height, ${CREATED_AT('t.unix_time')} AS created_at, b64u(i.owner_address) AS owner,
           i.data_size, i.content_type, b64u(i.root_transaction_id) AS bundle,
           t.app, t.app_version, t.cipher, coalesce(t.is_record, false) AS is_record
    FROM ${itemsSql(bands, lo, hi, false)} i LEFT JOIN t ON t.id = i.id AND t.height = i.height)`;
}

/**
 * The base objects over every registered band: the key macros, the `_all`
 * views (for the macros a SQL cell documents), the lookups when every band has
 * them, and the bounded table macros. Call after registering bands and again
 * after any change to the set; a selection's own layer (arfs.ts) comes after.
 */
export function l2BaseSql(bands: readonly RegisteredL2Band[]): string[] {
  const it = namesOf(bands, 'it');
  const tg = namesOf(bands, 'tg');
  const li = namesOf(bands, 'li');
  const lw = namesOf(bands, 'lw');
  const lg = namesOf(bands, 'lg');
  const lookups = hasLookups(bands);
  const out: string[] = [...KEY_MACROS];
  out.push(
    `CREATE OR REPLACE VIEW items_all AS SELECT id, height, owner_address, root_transaction_id, parent_id, data_size, content_type FROM ${readList(it)}`,
    `CREATE OR REPLACE MACRO items_between(lo, hi) AS TABLE
      SELECT id, height, any_value(owner_address) AS owner_address, any_value(root_transaction_id) AS root_transaction_id,
             any_value(data_size) AS data_size, any_value(content_type) AS content_type
      FROM items_all WHERE height BETWEEN lo AND hi GROUP BY id, height`,
    `CREATE OR REPLACE MACRO owners_between(lo, hi) AS TABLE
      SELECT id, height, any_value(owner_address) AS owner_address, any_value(data_size) AS data_size
      FROM items_all WHERE height BETWEEN lo AND hi GROUP BY id, height`,
    `CREATE OR REPLACE VIEW tags_all AS SELECT id, height, CAST(tag_name AS VARCHAR) AS name, CAST(tag_value AS VARCHAR) AS value FROM ${readList(tg)}`,
  );
  if (lookups) {
    out.push(
      `CREATE OR REPLACE VIEW lookup_id AS SELECT * FROM ${readList(li)}`,
      `CREATE OR REPLACE VIEW lookup_wallet AS SELECT * FROM ${readList(lw)}`,
      `CREATE OR REPLACE VIEW lookup_tag AS SELECT * FROM ${readList(lg)}`,
    );
  }
  out.push(
    `CREATE OR REPLACE MACRO uploads_between(lo, hi) AS TABLE
    WITH t AS (
      SELECT height, id,
        max(CASE WHEN name = 'App-Name' THEN value END) AS app,
        max(CASE WHEN name = 'App-Version' THEN value END) AS app_version,
        max(CASE WHEN name = 'Unix-Time' THEN try_cast(value AS BIGINT) END) AS unix_time,
        max(CASE WHEN name = 'Cipher' THEN value END) AS cipher,
        bool_or(name = 'Entity-Type') AS is_record
      FROM tags_all WHERE height BETWEEN lo AND hi AND name IN ('App-Name','App-Version','Unix-Time','Cipher','Entity-Type')
      GROUP BY height, id)
    SELECT b64u(i.id) AS id, i.height, ${CREATED_AT('t.unix_time')} AS created_at, b64u(i.owner_address) AS owner,
           i.data_size, i.content_type, b64u(i.root_transaction_id) AS bundle,
           t.app, t.app_version, t.cipher, coalesce(t.is_record, false) AS is_record
    FROM items_between(lo, hi) i LEFT JOIN t ON t.id = i.id AND t.height = i.height`,
  );
  if (lookups) {
    out.push(
      `CREATE OR REPLACE MACRO wallet_totals(a) AS TABLE
      SELECT count(*) FILTER (role = 0) AS uploads, count(*) FILTER (role = 1) AS received,
             round(sum(data_size) FILTER (role = 0) / power(2,30), 3) AS gib_uploaded,
             min(height) AS first_block, max(height) AS last_block
      FROM lookup_wallet WHERE addr8 = key64(unb64u(a))`,
      `CREATE OR REPLACE MACRO find_id(i) AS TABLE
      SELECT u.*, (SELECT string_agg(name || '=' || value, '  ') FROM tags_all g WHERE g.height = u.height AND g.id = unb64u(i)) AS tags
      FROM (SELECT * FROM items_all WHERE height IN (SELECT height FROM lookup_id WHERE id8 = key64(unb64u(i))) AND id = unb64u(i)) r
      JOIN LATERAL (SELECT b64u(r.id) AS id, r.height, b64u(r.owner_address) AS owner, r.data_size, r.content_type, b64u(r.root_transaction_id) AS bundle) u ON true`,
      `CREATE OR REPLACE MACRO tag_counts(n) AS TABLE
      SELECT CAST(value AS VARCHAR) AS value, sum(txs) AS uploads FROM lookup_tag WHERE name8 = hkey(n) AND name = CAST(n AS BLOB) GROUP BY ALL`,
    );
  } else {
    out.push(
      `CREATE OR REPLACE MACRO wallet_totals(a) AS TABLE
      SELECT count(*) AS uploads, 0 AS received, round(sum(data_size) / power(2,30), 3) AS gib_uploaded, min(height) AS first_block, max(height) AS last_block
      FROM items_all WHERE owner_address = unb64u(a)`,
      `CREATE OR REPLACE MACRO find_id(i) AS TABLE SELECT * FROM uploads WHERE id = i`,
      `CREATE OR REPLACE MACRO tag_counts(n) AS TABLE SELECT value, count(*) AS uploads FROM tags WHERE name = n GROUP BY value`,
    );
  }
  return out;
}

/** The period's generic views: `uploads` and `tags`, bounded to the period's heights. */
export function l2PeriodViewsSql(
  bands: readonly RegisteredL2Band[],
  lo: number,
  hi: number,
): string[] {
  return [
    `CREATE OR REPLACE VIEW uploads AS SELECT * FROM ${uploadsSql(bands, lo, hi)}`,
    `CREATE OR REPLACE VIEW tags AS SELECT b64u(id) AS id, height, name, value FROM ${tagsSql(bands, lo, hi)}`,
  ];
}

/** The exact counts of a tag's values over every band, from the tag lookup: kilobytes. */
export const tagCountsSql = (name: string): string =>
  `SELECT CAST(value AS VARCHAR) AS kind, sum(txs) AS n FROM lookup_tag WHERE name8 = hkey('${name}') AND name = CAST('${name}' AS BLOB) GROUP BY 1`;
