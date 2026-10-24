/**
 * ArDrive's layer over the generic `parquet-l2` layout: the ArFS file system
 * (https://docs.ardrive.io/docs/arfs/) read out of the `ardrive-l2`
 * selection's tags. One row per record (drive, folder, file, snapshot), the
 * ids that tie them into a tree, and the latest-version rule.
 *
 * This is the worked example of a selection layer. Another selection names
 * its own tags and writes its own pivot the same way: a `*Sql(bands, lo, hi)`
 * reader bounded by height, base macros that the page's lookups use, and the
 * period views a SQL cell documents. See docs/new-l2-index.md.
 */
import type { ReadAhead } from '../engine/read-ahead.js';
import {
  CREATED_AT,
  hasLookups,
  itemsSql,
  type L2Selection,
  type RegisteredL2Band,
  tagsSql,
  tagValueCountsSql,
  tagValuesReadAhead,
} from './parquet-l2.js';

/**
 * The data items this layer reads: ArDrive's, by `App-Name`. A page refuses
 * an index that selects anything else, whatever it is called: its counts and
 * its "every drive" would not be ArDrive's.
 */
export const ARDRIVE_SELECTION: L2Selection = {
  kind: 'ans104-data-items',
  tag: { name: 'App-Name', valuePrefix: 'ArDrive', excludeValuePrefix: 'ArDriver' },
};

/** The tags the pivot reads. Everything else on a record is left for `tags`. */
export const ENTITY_TAGS =
  "'Entity-Type','Drive-Id','File-Id','Folder-Id','Parent-Folder-Id','Drive-Privacy','Cipher','ArFS','App-Name','App-Version','Unix-Time','Is-Hidden'";

export const ARFS_OBJECTS = {
  views: ['entities', 'drives', 'folders', 'files'],
  macros: ['entities_between', 'drive_window', 'drive'],
};

export const arfsDropSql = (): string[] => [
  ...ARFS_OBJECTS.views.map((v) => `DROP VIEW IF EXISTS ${v}`),
  ...ARFS_OBJECTS.macros.map((m) => `DROP MACRO TABLE IF EXISTS ${m}`),
];

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

const ENTITY_SELECT = (
  items: string,
) => `SELECT b64u(e.id) AS id, e.height, ${CREATED_AT('e.unix_time')} AS created_at, b64u(i.owner_address) AS owner,
           e.kind, e.drive_id, e.entity_id, e.parent_folder_id,
           CASE WHEN e.privacy IS NOT NULL THEN e.privacy WHEN e.cipher IS NOT NULL THEN 'private' ELSE 'public' END AS privacy,
           e.cipher, e.arfs, e.app, e.app_version, e.unix_time, e.is_hidden, i.data_size AS record_size
    FROM e JOIN ${items} i ON i.id = e.id AND i.height = e.height`;

/**
 * Every ArFS record in a window, one row each, its tags as columns, with its
 * owner and the size of its JSON (`record_size`), from a join on the slim items.
 */
export function entitiesSql(bands: readonly RegisteredL2Band[], lo: number, hi: number): string {
  return `(${ENTITY_PIVOT(tagsSql(bands, lo, hi))}
    ${ENTITY_SELECT(itemsSql(bands, lo, hi, true))})`;
}

/**
 * The macros the ArDrive page's lookups use, over the generic base
 * (`tags_all`, `owners_between`, `lookup_tag`): `entities_between(lo, hi)`,
 * and, with lookups, `drive_window(d)` (count and first/last height of a
 * Drive-Id from the tag lookup) and `drive(d)` (every record of a drive).
 */
export function arfsBaseSql(bands: readonly RegisteredL2Band[]): string[] {
  const out = [
    `CREATE OR REPLACE MACRO entities_between(lo, hi) AS TABLE
    ${ENTITY_PIVOT(`(SELECT * FROM tags_all WHERE height BETWEEN lo AND hi)`)}
    ${ENTITY_SELECT('owners_between(lo, hi)')}`,
  ];
  if (hasLookups(bands)) {
    out.push(
      `CREATE OR REPLACE MACRO drive_window(d) AS TABLE
      SELECT sum(txs)::BIGINT AS records, min(first_height) AS lo, max(last_height) AS hi
      FROM lookup_tag WHERE name8 = hkey('Drive-Id') AND val8 = hkey(d) AND name = CAST('Drive-Id' AS BLOB) AND value = CAST(d AS BLOB)`,
      `CREATE OR REPLACE MACRO drive(d) AS TABLE
      SELECT * FROM entities_between((SELECT lo FROM drive_window(d)), (SELECT hi FROM drive_window(d))) WHERE drive_id = d`,
    );
  } else {
    out.push(`CREATE OR REPLACE MACRO drive(d) AS TABLE SELECT * FROM entities WHERE drive_id = d`);
  }
  return out;
}

/**
 * The period's ArFS views: `entities` (every record, every version) and one
 * row per drive, folder or file (`drives`, `folders`, `files`: the newest
 * record wins, as ArFS says, with `versions` counting the records in the period).
 */
export function arfsPeriodViewsSql(
  bands: readonly RegisteredL2Band[],
  lo: number,
  hi: number,
): string[] {
  const latest = (kind: string, key: string) => `SELECT * EXCLUDE (rn) FROM (
      SELECT *, entity_id AS ${key}, id AS name_id, row_number() OVER (PARTITION BY entity_id ORDER BY height DESC, unix_time DESC NULLS LAST) AS rn,
             count(*) OVER (PARTITION BY entity_id) AS versions
      FROM entities WHERE kind = '${kind}' AND entity_id IS NOT NULL) WHERE rn = 1`;
  return [
    `CREATE OR REPLACE VIEW entities AS SELECT * FROM ${entitiesSql(bands, lo, hi)}`,
    `CREATE OR REPLACE VIEW drives AS ${latest('drive', 'drive_key')}`,
    `CREATE OR REPLACE VIEW folders AS ${latest('folder', 'folder_id')}`,
    `CREATE OR REPLACE VIEW files AS ${latest('file', 'file_id')}`,
  ];
}

/** Drive records of a window, the newest version per Drive-Id, newest first. */
export function newestDrivesSql(
  bands: readonly RegisteredL2Band[],
  lo: number,
  hi: number,
  where = '',
): string {
  return `SELECT id, height, created_at, owner, drive_id, privacy, app, app_version, arfs, record_size, versions
        FROM (SELECT *, count(*) OVER (PARTITION BY drive_id) AS versions, row_number() OVER (PARTITION BY drive_id ORDER BY height DESC, unix_time DESC NULLS LAST) AS rn
              FROM ${entitiesSql(bands, lo, hi)} WHERE kind = 'drive'${where})
        WHERE rn = 1 ORDER BY height DESC, unix_time DESC NULLS LAST`;
}

/** Entities of several height stretches at once, as one source. */
export const clusterSql = (
  bands: readonly RegisteredL2Band[],
  clusters: readonly [number, number][],
  where: string,
): string =>
  clusters
    .map(([a, z]) => `SELECT * FROM ${entitiesSql(bands, a, z)} WHERE ${where}`)
    .join(' UNION ALL ');

/**
 * How many records each drive has over its whole history, from the tag
 * lookup: every ArFS record carries its drive's `Drive-Id`, so a drive with
 * nothing in it holds 2 (itself and its root folder). `from` is the oldest of
 * these drives' heights: no record of a drive comes before the drive.
 * `drive_id, records`.
 */
export const driveRecordCountsSql = (
  bands: readonly RegisteredL2Band[],
  driveIds: readonly string[],
  from: number,
): string =>
  `(SELECT value AS drive_id, uploads AS records FROM ${tagValueCountsSql(bands, 'Drive-Id', driveIds, from)})`;

/** What `driveRecordCountsSql` will fetch. */
export const driveRecordCountsReadAhead = (
  bands: readonly RegisteredL2Band[],
  driveIds: readonly string[],
  from: number,
): ReadAhead => tagValuesReadAhead(bands, 'Drive-Id', driveIds, from);
