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
import type { Publication, PublicationIndex } from '../publication.js';
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

/**
 * What a `parquet-l2` index holds: the data items one tag selects. An item is
 * in it when one of its tags is named `name` exactly and its value starts
 * with `valuePrefix` and not with `excludeValuePrefix`, as UTF-8 bytes.
 */
export interface L2Selection {
  kind: 'ans104-data-items';
  tag: { name: string; valuePrefix: string; excludeValuePrefix?: string };
}

const SELECTION_MAX_BYTES = 256;

function no(why: string): never {
  throw new Error(`the selection is not well formed: ${why}`);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A selection as the publication declares it, checked field by field; throws on anything else. */
export function parseL2Selection(raw: unknown): L2Selection {
  if (!isObj(raw)) no('not an object');
  const extra = (o: Record<string, unknown>, allowed: string[], where: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) no(`${where}${k} is not allowed`);
  };
  extra(raw, ['kind', 'tag'], '');
  if (raw.kind !== 'ans104-data-items') no(`kind ${JSON.stringify(raw.kind)}`);
  const tag = raw.tag;
  if (!isObj(tag)) no('tag');
  extra(tag, ['name', 'valuePrefix', 'excludeValuePrefix'], 'tag.');
  const str = (k: string, required: boolean): string | undefined => {
    const v = tag[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string') return no(`tag.${k}`);
    if (new TextEncoder().encode(v).length > SELECTION_MAX_BYTES) no(`tag.${k} is too long`);
    return v;
  };
  const name = str('name', true)!;
  const valuePrefix = str('valuePrefix', true)!;
  const excludeValuePrefix = str('excludeValuePrefix', false);
  if (!name) no('tag.name is empty');
  const out: L2Selection = { kind: 'ans104-data-items', tag: { name, valuePrefix } };
  if (excludeValuePrefix !== undefined) {
    if (!excludeValuePrefix.startsWith(valuePrefix) || excludeValuePrefix === valuePrefix)
      no('tag.excludeValuePrefix must extend tag.valuePrefix');
    out.tag.excludeValuePrefix = excludeValuePrefix;
  }
  return out;
}

export const sameL2Selection = (a: L2Selection, b: L2Selection): boolean =>
  a.kind === b.kind &&
  a.tag.name === b.tag.name &&
  a.tag.valuePrefix === b.tag.valuePrefix &&
  a.tag.excludeValuePrefix === b.tag.excludeValuePrefix;

/** `App-Name starting "ArDrive", not "ArDriver"`: a selection for a reader. */
export const describeL2Selection = (s: L2Selection): string =>
  `${s.tag.name} starting ${JSON.stringify(s.tag.valuePrefix)}` +
  (s.tag.excludeValuePrefix !== undefined
    ? `, not ${JSON.stringify(s.tag.excludeValuePrefix)}`
    : '');

/**
 * The one selection every band of a `parquet-l2` index declares (as its
 * `metadata.selection`), which the index's `filter` must also be when the
 * publisher sets one. Throws when a band has none, or any two disagree: then
 * no band of the index can be trusted to hold what the others say.
 */
export function l2SelectionOf(ix: PublicationIndex): L2Selection {
  if (ix.kind !== 'parquet-l2') throw new Error(`${ix.name} is a ${ix.kind} index, not parquet-l2`);
  if (!ix.bands.length) throw new Error(`${ix.name} lists no bands`);
  let one: L2Selection | null = null;
  for (const b of ix.bands) {
    if (b.metadata?.selection === undefined)
      throw new Error(`${ix.name}: band ${b.id} declares no selection`);
    const s = parseL2Selection(b.metadata.selection);
    if (one && !sameL2Selection(one, s))
      throw new Error(
        `${ix.name}: band ${b.id} selects ${describeL2Selection(s)}, its other bands ${describeL2Selection(one)}`,
      );
    one = s;
  }
  if (ix.filter !== undefined) {
    const f = parseL2Selection(ix.filter);
    if (!sameL2Selection(one!, f))
      throw new Error(
        `${ix.name}: its filter selects ${describeL2Selection(f)}, its bands ${describeL2Selection(one!)}`,
      );
  }
  return one!;
}

/**
 * The name of the `parquet-l2` index that selects exactly `want`: `prefer`
 * when it does, else the first that does. With none, why: what each
 * `parquet-l2` index selects instead, or why its selection is refused.
 */
export function findL2Index(
  pub: Publication,
  want: L2Selection,
  prefer?: string,
): { name: string } | { name: null; why: string } {
  const seen: string[] = [];
  const matches: string[] = [];
  for (const ix of pub.indexes) {
    if (ix.kind !== 'parquet-l2') continue;
    try {
      const s = l2SelectionOf(ix);
      if (sameL2Selection(s, want)) matches.push(ix.name);
      else seen.push(`${ix.name} selects ${describeL2Selection(s)}`);
    } catch (e) {
      seen.push((e as Error).message);
    }
  }
  if (prefer !== undefined && matches.includes(prefer)) return { name: prefer };
  if (matches.length) return { name: matches[0]! };
  return {
    name: null,
    why:
      `no index here selects ${describeL2Selection(want)}` +
      (seen.length ? ` (${seen.join('; ')})` : ''),
  };
}

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
 * How many uploads carry `name` = each of `values`, over every band from
 * height `from` on (a selection that knows its values cannot appear earlier
 * passes that height; 0 reads every band): `value, uploads, first_height,
 * last_height`, a row for each value found. One point lookup per value, so
 * each reads only the row group its key falls in, in each band.
 */
export function tagValueCountsSql(
  bands: readonly RegisteredL2Band[],
  name: string,
  values: readonly string[],
  from = 0,
): string {
  const f = namesOf(
    bands.filter((b) => b.to >= from),
    'lg',
  );
  if (!f.length || !values.length)
    return `(SELECT NULL::VARCHAR AS value, NULL::BIGINT AS uploads, NULL::UBIGINT AS first_height, NULL::UBIGINT AS last_height WHERE false)`;
  const n = sq(name);
  const one = (v: string) =>
    `SELECT value, txs, first_height, last_height FROM ${readList(f)}
      WHERE name8 = hkey(${n}) AND val8 = hkey(${sq(v)}) AND name = CAST(${n} AS BLOB) AND value = CAST(${sq(v)} AS BLOB)`;
  return `(SELECT CAST(value AS VARCHAR) AS value, sum(txs)::BIGINT AS uploads, min(first_height) AS first_height, max(last_height) AS last_height
    FROM (${values.map(one).join('\n    UNION ALL ')}) GROUP BY 1)`;
}

/** What `tagValueCountsSql` will fetch: the row groups each value's key can sit in, and their bloom filters. */
export function tagValuesReadAhead(
  bands: readonly RegisteredL2Band[],
  name: string,
  values: readonly string[],
  from = 0,
): ReadAhead {
  const n = `hkey(${sq(name)})`;
  return {
    files: namesOf(
      bands.filter((b) => b.to >= from),
      'lg',
    ),
    keep: [
      { column: 'name8', lo: n, hi: n },
      { column: 'val8', any: values.map((v) => `hkey(${sq(v)})`) },
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
