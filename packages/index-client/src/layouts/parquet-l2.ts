/**
 * The `parquet-l2` layout (`l2-1`): one selection's ANS-104 data items as
 * Parquet, with tags, owners, and three lookup files. For ArDrive the
 * selection is App-Name starting with "ArDrive", and the interesting rows are
 * ArFS records: data items whose tags carry Entity-Type and the ArFS ids.
 *
 * Everything here is SQL text over registered file names. The pivot of ArFS
 * tags into entities is this layout's business, not an app's. Every reader
 * is bounded by height so the Parquet reader prunes row groups, and a view
 * over a window names only the files of the bands that window touches: a
 * view over every band would read every file's footer on the first query.
 */
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

/** The views, macros and base objects this layout creates, for a clean drop. */
export const L2_OBJECTS = {
  views: ['uploads', 'tags', 'entities', 'drives', 'folders', 'files', 'uploads_all', 'tags_all', 'items_all', 'lookup_id', 'lookup_wallet', 'lookup_tag'],
  macros: ['items_between', 'owners_between', 'entities_between', 'uploads_between', 'drive_window', 'drive', 'wallet_totals', 'find_id', 'tag_counts'],
};

export const l2DropSql = (): string[] => [
  ...L2_OBJECTS.views.map((v) => `DROP VIEW IF EXISTS ${v}`),
  ...L2_OBJECTS.macros.map((m) => `DROP MACRO TABLE IF EXISTS ${m}`),
];

const namesOf = (bands: readonly RegisteredL2Band[], kind: L2Kind): string[] =>
  bands.map((b) => b.names[kind]).filter((n): n is string => !!n);

/** The bands a height window touches. */
export const bandsInWindow = (bands: readonly RegisteredL2Band[], lo: number, hi: number): RegisteredL2Band[] =>
  bands.filter((b) => b.to >= lo && b.from <= hi);

/** Whether every band carries its three lookup files, so the lookup paths can be used. */
export const hasLookups = (bands: readonly RegisteredL2Band[]): boolean =>
  bands.length > 0 && bands.every((b) => b.names.li && b.names.lw && b.names.lg);

export const ENTITY_TAGS =
  "'Entity-Type','Drive-Id','File-Id','Folder-Id','Parent-Folder-Id','Drive-Privacy','Cipher','ArFS','App-Name','App-Version','Unix-Time','Is-Hidden'";

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
export function itemsSql(bands: readonly RegisteredL2Band[], lo: number, hi: number, slim: boolean): string {
  const f = namesOf(bandsInWindow(bands, lo, hi), 'it');
  if (!f.length) return EMPTY_ITEMS;
  const cols = slim
    ? 'any_value(owner_address) AS owner_address, any_value(data_size) AS data_size'
    : 'any_value(owner_address) AS owner_address, any_value(root_transaction_id) AS root_transaction_id, any_value(data_size) AS data_size, any_value(content_type) AS content_type';
  return `(SELECT id, height, ${cols} FROM ${readList(f)} WHERE height BETWEEN ${lo} AND ${hi} GROUP BY id, height)`;
}

const ENTITY_PIVOT = (tagsSource: string) => `WITH e AS (
      SELECT height, id,
        max(CASE WHEN name = 'Entity-Type' THEN value END) AS kind,
        max(CASE WHEN name = 'Drive-Id' THEN value END) AS drive_id,
        coalesce(max(CASE WHEN name = 'Drive-Id' AND kind0 = 'drive' THEN value END), max(CASE WHEN name = 'Folder-Id' THEN value END), max(CASE WHEN name = 'File-Id' THEN value END)) AS entity_id,
        max(CASE WHEN name = 'Parent-Folder-Id' THEN value END) AS parent_folder_id,
        max(CASE WHEN name = 'Drive-Privacy' THEN value END) AS privacy,
        max(CASE WHEN name = 'Cipher' THEN value END) AS cipher,
        max(CASE WHEN name = 'ArFS' THEN value END) AS arfs,
        max(CASE WHEN name = 'App-Name' THEN value END) AS app,
        max(CASE WHEN name = 'App-Version' THEN value END) AS app_version,
        max(CASE WHEN name = 'Unix-Time' THEN try_cast(value AS BIGINT) END) AS unix_time,
        max(CASE WHEN name = 'Is-Hidden' THEN value END) AS is_hidden
      FROM (SELECT t.*, max(CASE WHEN name = 'Entity-Type' THEN value END) OVER (PARTITION BY height, id) AS kind0
            FROM ${tagsSource} t WHERE name IN (${ENTITY_TAGS}))
      GROUP BY height, id HAVING kind IS NOT NULL)`;

/**
 * A Unix-Time stamped in milliseconds (some apps did) would throw in
 * Date#toISOString; the value is bounded here so no formatter ever sees it.
 */
const CREATED_AT = (expr: string) => `CASE WHEN ${expr} BETWEEN 1000000000 AND 4000000000 THEN epoch_ms(${expr} * 1000) END`;

/**
 * Every ArFS record in a window, one row each, its tags as columns, with its
 * owner and the size of its JSON (`record_size`), from a join on the slim items.
 */
export function entitiesSql(bands: readonly RegisteredL2Band[], lo: number, hi: number): string {
  return `(${ENTITY_PIVOT(tagsSql(bands, lo, hi))}
    SELECT b64u(e.id) AS id, e.height, ${CREATED_AT('e.unix_time')} AS created_at, b64u(i.owner_address) AS owner,
           e.kind, e.drive_id, e.entity_id, e.parent_folder_id,
           CASE WHEN e.privacy IS NOT NULL THEN e.privacy WHEN e.cipher IS NOT NULL THEN 'private' ELSE 'public' END AS privacy,
           e.cipher, e.arfs, e.app, e.app_version, e.unix_time, e.is_hidden, i.data_size AS record_size
    FROM e JOIN ${itemsSql(bands, lo, hi, true)} i ON i.id = e.id AND i.height = e.height)`;
}

/** Every upload in a window with the app that made it and the time it stamped. */
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
 * after any change to the set.
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
    `CREATE OR REPLACE MACRO entities_between(lo, hi) AS TABLE
    ${ENTITY_PIVOT(`(SELECT * FROM tags_all WHERE height BETWEEN lo AND hi)`)}
    SELECT b64u(e.id) AS id, e.height, ${CREATED_AT('e.unix_time')} AS created_at, b64u(i.owner_address) AS owner,
           e.kind, e.drive_id, e.entity_id, e.parent_folder_id,
           CASE WHEN e.privacy IS NOT NULL THEN e.privacy WHEN e.cipher IS NOT NULL THEN 'private' ELSE 'public' END AS privacy,
           e.cipher, e.arfs, e.app, e.app_version, e.unix_time, e.is_hidden, i.data_size AS record_size
    FROM e JOIN owners_between(lo, hi) i ON i.id = e.id AND i.height = e.height`,
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
      `CREATE OR REPLACE MACRO drive_window(d) AS TABLE
      SELECT sum(txs)::BIGINT AS records, min(first_height) AS lo, max(last_height) AS hi
      FROM lookup_tag WHERE name8 = hkey('Drive-Id') AND val8 = hkey(d) AND name = CAST('Drive-Id' AS BLOB) AND value = CAST(d AS BLOB)`,
      `CREATE OR REPLACE MACRO drive(d) AS TABLE
      SELECT * FROM entities_between((SELECT lo FROM drive_window(d)), (SELECT hi FROM drive_window(d))) WHERE drive_id = d`,
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
      `CREATE OR REPLACE MACRO drive(d) AS TABLE SELECT * FROM entities WHERE drive_id = d`,
      `CREATE OR REPLACE MACRO wallet_totals(a) AS TABLE
      SELECT count(*) AS uploads, 0 AS received, round(sum(data_size) / power(2,30), 3) AS gib_uploaded, min(height) AS first_block, max(height) AS last_block
      FROM items_all WHERE owner_address = unb64u(a)`,
      `CREATE OR REPLACE MACRO find_id(i) AS TABLE SELECT * FROM uploads WHERE id = i`,
      `CREATE OR REPLACE MACRO tag_counts(n) AS TABLE SELECT value, count(*) AS uploads FROM tags WHERE name = n GROUP BY value`,
    );
  }
  return out;
}

/**
 * The period's views: `uploads`, `tags`, `entities`, and one row per drive,
 * folder or file (`drives`, `folders`, `files`: the newest record wins, as
 * ArFS says, with `versions` counting the records in the period).
 */
export function l2PeriodViewsSql(bands: readonly RegisteredL2Band[], lo: number, hi: number): string[] {
  const latest = (kind: string, key: string) => `SELECT * EXCLUDE (rn) FROM (
      SELECT *, entity_id AS ${key}, id AS name_id, row_number() OVER (PARTITION BY entity_id ORDER BY height DESC, unix_time DESC NULLS LAST) AS rn,
             count(*) OVER (PARTITION BY entity_id) AS versions
      FROM entities WHERE kind = '${kind}' AND entity_id IS NOT NULL) WHERE rn = 1`;
  return [
    `CREATE OR REPLACE VIEW uploads AS SELECT * FROM ${uploadsSql(bands, lo, hi)}`,
    `CREATE OR REPLACE VIEW tags AS SELECT b64u(id) AS id, height, name, value FROM ${tagsSql(bands, lo, hi)}`,
    `CREATE OR REPLACE VIEW entities AS SELECT * FROM ${entitiesSql(bands, lo, hi)}`,
    `CREATE OR REPLACE VIEW drives AS ${latest('drive', 'drive_key')}`,
    `CREATE OR REPLACE VIEW folders AS ${latest('folder', 'folder_id')}`,
    `CREATE OR REPLACE VIEW files AS ${latest('file', 'file_id')}`,
  ];
}

/** Drive records of a window, the newest version per Drive-Id, newest first. */
export function newestDrivesSql(bands: readonly RegisteredL2Band[], lo: number, hi: number, where = ''): string {
  return `SELECT id, height, created_at, owner, drive_id, privacy, app, app_version, arfs, record_size, versions
        FROM (SELECT *, count(*) OVER (PARTITION BY drive_id) AS versions, row_number() OVER (PARTITION BY drive_id ORDER BY height DESC, unix_time DESC NULLS LAST) AS rn
              FROM ${entitiesSql(bands, lo, hi)} WHERE kind = 'drive'${where})
        WHERE rn = 1 ORDER BY height DESC, unix_time DESC NULLS LAST`;
}

/** Entities of several height stretches at once, as one source. */
export const clusterSql = (bands: readonly RegisteredL2Band[], clusters: readonly [number, number][], where: string): string =>
  clusters.map(([a, z]) => `SELECT * FROM ${entitiesSql(bands, a, z)} WHERE ${where}`).join(' UNION ALL ');

/** The exact counts of a tag's values over every band, from the tag lookup: kilobytes. */
export const tagCountsSql = (name: string): string =>
  `SELECT CAST(value AS VARCHAR) AS kind, sum(txs) AS n FROM lookup_tag WHERE name8 = hkey('${name}') AND name = CAST('${name}' AS BLOB) GROUP BY 1`;
