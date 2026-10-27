/**
 * The questions and presets, in ArDrive's words. Each question has its
 * period SQL and caption; some also have a lookup-based form that answers the
 * count half over everything the index holds (kilobytes from `lookup_tag`),
 * used when the period is too large to scan.
 */
export interface Question {
  title: string;
  sub: string;
  sql: string;
  /** {RANGE} is filled with the period's dates. */
  caption: string;
  /** The all-history form, from the lookups; {TOTAL} is the publication's record count. */
  wideSql?: string;
  wideCaption?: string;
}

export const QUESTIONS: Question[] = [
  {
    title: 'What do people keep on ArDrive?',
    sub: 'File types, by count and size',
    sql: "SELECT coalesce(content_type, '(no type)') AS type,\n       count(*) AS files,\n       round(sum(data_size) / power(2,30), 2) AS gib\nFROM uploads\nWHERE NOT is_record\nGROUP BY 1\nORDER BY gib DESC\nLIMIT 15;",
    caption:
      'File data uploaded through ArDrive {RANGE}, by its content type. Drive, folder and file records (small JSON) are left out.',
    wideSql:
      "SELECT value AS type, uploads\nFROM tag_counts('Content-Type')\nORDER BY uploads DESC\nLIMIT 15;",
    wideCaption:
      'Uploads by content type over <strong>everything the index holds</strong>, as exact counts from the index’s own lookups (kilobytes to read). Records count here too (application/json). Bytes need a scan: pick a period for those.',
  },
  {
    title: 'How many drives were created?',
    sub: 'Public and private, by month',
    sql: "SELECT strftime(date_trunc('month', created_at), '%Y-%m') AS month,\n       count(*) FILTER (WHERE privacy = 'public') AS public_drives,\n       count(*) FILTER (WHERE privacy = 'private') AS private_drives,\n       count(DISTINCT owner) AS owners\nFROM drives\nGROUP BY date_trunc('month', created_at)\nORDER BY date_trunc('month', created_at);",
    caption: 'Drives whose record was written {RANGE}, by the month the app stamped on it.',
    wideSql:
      "SELECT value AS kind, uploads AS records\nFROM tag_counts('Entity-Type')\nORDER BY records DESC;",
    wideCaption:
      'Drive, folder, file and snapshot records over <strong>everything the index holds</strong>: exact counts from the lookups. Drives by month need a scan: pick a period.',
  },
  {
    title: 'Who stores the most?',
    sub: 'Wallets ranked by bytes',
    sql: 'SELECT u.owner AS owner,\n       count(*) AS uploads,\n       round(sum(u.data_size) / power(2,30), 2) AS gib,\n       count(DISTINCT e.drive_id) FILTER (WHERE e.drive_id IS NOT NULL) AS drives_touched\nFROM uploads u\nLEFT JOIN entities e USING (id, height)\nGROUP BY u.owner\nORDER BY gib DESC\nLIMIT 15;',
    caption:
      'Wallets by bytes uploaded through ArDrive {RANGE}. Select an address to open the wallet.',
  },
  {
    title: 'Biggest files',
    sub: 'The largest uploads',
    sql: 'SELECT id, owner, round(data_size / power(2,20), 1) AS mib, content_type, created_at\nFROM uploads\nWHERE NOT is_record\nORDER BY data_size DESC\nLIMIT 15;',
    caption:
      'The largest file data uploaded {RANGE}. Select an id to open it and the drive it belongs to.',
  },
  {
    title: 'Public or private?',
    sub: 'How much is encrypted',
    sql: "SELECT CASE WHEN cipher IS NULL THEN 'public' ELSE 'private' END AS how,\n       count(*) AS uploads,\n       round(sum(data_size) / power(2,30), 2) AS gib,\n       count(DISTINCT owner) AS wallets\nFROM uploads\nWHERE NOT is_record\nGROUP BY 1\nORDER BY gib DESC;",
    caption:
      'File data {RANGE}: private files are encrypted before upload with a key only the drive owner holds, so only their size is known.',
    wideSql:
      "WITH c AS (SELECT sum(uploads) AS private FROM tag_counts('Cipher'))\nSELECT 'private' AS how, private AS uploads FROM c\nUNION ALL\nSELECT 'public', {TOTAL} - private FROM c;",
    wideCaption:
      'Uploads with a Cipher tag (encrypted) against all {TOTAL_TEXT} uploads the publication signs, over <strong>everything the index holds</strong>: exact counts from the lookups. Bytes need a scan: pick a period.',
  },
  {
    title: 'Which apps and versions?',
    sub: 'What wrote the uploads',
    sql: 'SELECT app, app_version, count(*) AS uploads, round(sum(data_size) / power(2,30), 2) AS gib\nFROM uploads\nGROUP BY 1, 2\nORDER BY uploads DESC\nLIMIT 15;',
    caption: 'Every upload names the app that made it (App-Name and App-Version tags), {RANGE}.',
    wideSql:
      "SELECT value AS app, uploads\nFROM tag_counts('App-Name')\nORDER BY uploads DESC\nLIMIT 15;",
    wideCaption:
      'Uploads by app over <strong>everything the index holds</strong>: exact counts from the lookups. Versions and bytes need a scan: pick a period.',
  },
  {
    title: 'New wallets',
    sub: 'First-time uploaders, by month',
    sql: "WITH firsts AS (\n  SELECT owner, min(created_at) AS first_seen FROM uploads GROUP BY owner\n)\nSELECT strftime(date_trunc('month', first_seen), '%Y-%m') AS month, count(*) AS new_wallets\nFROM firsts\nGROUP BY date_trunc('month', first_seen)\nORDER BY date_trunc('month', first_seen);",
    caption:
      'Wallets whose first ArDrive upload in this period fell in each month. Over a short period, every wallet looks new: widen it for the real picture.',
  },
  {
    title: 'Where do the bytes go?',
    sub: 'Uploads by size',
    sql: "SELECT CASE WHEN data_size < 1024 THEN 'a. under 1 KB'\n            WHEN data_size < 102400 THEN 'b. under 100 KB'\n            WHEN data_size < 1048576 THEN 'c. under 1 MB'\n            WHEN data_size < 104857600 THEN 'd. under 100 MB'\n            ELSE 'e. 100 MB and up' END AS size_bucket,\n       count(*) AS uploads,\n       round(sum(data_size) / power(2,30), 2) AS gib\nFROM uploads\nGROUP BY 1\nORDER BY 1;",
    caption: 'Most uploads are tiny records; most bytes are a few large files. {RANGE}.',
  },
];

export interface Preset {
  label: string;
  /** {WALLET} and {DRIVE} are filled with ids from the loaded data, so presets never run empty. */
  sql: string;
}

export const PRESETS: Preset[] = [
  {
    label: 'Newest drives',
    sql: 'SELECT drive_id, name_id, owner, privacy, created_at, app\nFROM drives\nORDER BY created_at DESC\nLIMIT 25;',
  },
  {
    label: 'Busiest drives',
    sql: 'SELECT drive_id, count(*) AS files, count(DISTINCT owner) AS writers, min(created_at) AS first, max(created_at) AS last\nFROM files\nGROUP BY drive_id\nORDER BY files DESC\nLIMIT 15;',
  },
  {
    label: 'One drive',
    sql: "-- every record of one drive, by its Drive-Id, found through the lookups\nSELECT kind, id, created_at, entity_id, parent_folder_id, app_version\nFROM drive('{DRIVE}')\nORDER BY created_at;",
  },
  { label: 'One wallet: totals', sql: "SELECT * FROM wallet_totals('{WALLET}');" },
  {
    label: 'Files by day',
    sql: "SELECT strftime(date_trunc('day', created_at), '%Y-%m-%d') AS day, count(*) AS files, count(DISTINCT drive_id) AS drives\nFROM files\nGROUP BY date_trunc('day', created_at)\nORDER BY date_trunc('day', created_at);",
  },
  {
    label: 'Deepest folders',
    sql: 'WITH RECURSIVE path(folder_id, depth) AS (\n  SELECT folder_id, 1 FROM folders WHERE parent_folder_id IS NULL\n  UNION ALL\n  SELECT f.folder_id, p.depth + 1 FROM folders f JOIN path p ON f.parent_folder_id = p.folder_id WHERE p.depth < 30\n)\nSELECT depth, count(*) AS folders FROM path GROUP BY depth ORDER BY depth;',
  },
  {
    label: 'Everything in this period',
    sql: 'SELECT count(*) AS uploads,\n       count(*) FILTER (WHERE is_record) AS records,\n       count(DISTINCT owner) AS wallets,\n       round(sum(data_size) / power(2,30), 2) AS gib,\n       min(created_at) AS from_time, max(created_at) AS to_time\nFROM uploads;',
  },
];

export const presetSql = (
  p: Preset,
  sampleWallet: string | null,
  sampleDrive: string | null,
): string =>
  p.sql
    .replaceAll('{WALLET}', sampleWallet ?? 'paste-an-address-here')
    .replaceAll('{DRIVE}', sampleDrive ?? 'paste-a-drive-id-here');

/** Column names as a table header shows them; exports keep the SQL names. */
const COLUMN_LABELS: Record<string, string> = {
  type: 'Type',
  files: 'Files',
  gib: 'GiB',
  mib: 'MiB',
  month: 'Month',
  day: 'Day',
  public_drives: 'Public drives',
  private_drives: 'Private drives',
  owners: 'Owners',
  owner: 'Owner',
  kind: 'Kind',
  records: 'Records',
  uploads: 'Uploads',
  drives_touched: 'Drives touched',
  id: 'Id',
  content_type: 'Content type',
  created_at: 'Created',
  how: 'Public or private',
  wallets: 'Wallets',
  app: 'App',
  app_version: 'Version',
  new_wallets: 'New wallets',
  size_bucket: 'Size',
  drive_id: 'Drive',
  name_id: 'Name record',
  privacy: 'Privacy',
  writers: 'Writers',
  first: 'First',
  last: 'Last',
  entity_id: 'Entity',
  parent_folder_id: 'Parent folder',
  drives: 'Drives',
  depth: 'Depth',
  folders: 'Folders',
  from_time: 'From',
  to_time: 'To',
};

export const columnLabel = (key: string): string => COLUMN_LABELS[key] ?? key;

/** A question or preset found again from its SQL: a link or a history entry carries only the SQL. */
export interface Asked {
  title: string;
  /** With {RANGE}, or {TOTAL_TEXT} for a question's all-history form. */
  caption: string | null;
  /** The question's index, for its card; null for a preset. */
  question: number | null;
  /** The all-history form, which reads the lookups and needs no cost card. */
  wide: boolean;
}

const norm = (sql: string): string =>
  sql
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\s+/g, ' ');
/** A template's SQL as a pattern: the filled-in slots ({TOTAL}, {WALLET}, {DRIVE}) match any one value. */
const matches = (template: string, sql: string): boolean =>
  new RegExp(
    '^' +
      norm(template)
        .split(/\{(?:TOTAL|WALLET|DRIVE)\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join("[^\\s']+") +
      '$',
  ).test(norm(sql));

export function askedFor(sql: string): Asked | null {
  for (const [i, q] of QUESTIONS.entries()) {
    if (matches(q.sql, sql))
      return { title: q.title, caption: q.caption, question: i, wide: false };
    if (q.wideSql && matches(q.wideSql, sql))
      return { title: q.title, caption: q.wideCaption ?? null, question: i, wide: true };
  }
  for (const p of PRESETS)
    if (matches(p.sql, sql)) return { title: p.label, caption: null, question: null, wide: false };
  return null;
}

/** Splits a caption with <strong> marks into segments, so nothing is rendered as HTML. */
export function captionSegments(text: string): { text: string; strong: boolean }[] {
  const out: { text: string; strong: boolean }[] = [];
  const re = /<strong>(.*?)<\/strong>/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), strong: false });
    out.push({ text: m[1]!, strong: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), strong: false });
  return out;
}
