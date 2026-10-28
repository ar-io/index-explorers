import { fmtRange, num } from '@ar-io/index-client';

/** The questions and presets of the L1 page: each checked against the real newest band. */
export interface Question {
  title: string;
  sub: string;
  sql: string;
  /** {RANGE} is filled with the period's dates. */
  caption: string;
}

export const QUESTIONS: Question[] = [
  {
    title: 'Which apps write to Arweave?',
    sub: 'Ranked by transactions',
    sql: "SELECT value AS app, transactions\nFROM tag_counts('App-Name')\nORDER BY transactions DESC\nLIMIT 15;",
    caption:
      'Apps that sent transactions straight to Arweave, {RANGE}. Most uploads travel inside bundles instead, and the apps inside those are not counted here.',
  },
  {
    title: 'How much arrives in bundles?',
    sub: 'Bundled versus sent directly',
    sql: "WITH bundles AS (\n  SELECT DISTINCT tx_id FROM tags WHERE lower(name) = 'bundle-format'\n)\nSELECT CASE WHEN b.tx_id IS NULL THEN 'Sent directly' ELSE 'In a bundle' END AS how,\n       count(*) AS transactions,\n       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS percent,\n       round(sum(t.data_size) / power(2,30), 1) AS gib\nFROM txs t LEFT JOIN bundles b USING (tx_id)\nGROUP BY how\nORDER BY transactions DESC;",
    caption:
      'A bundle packs many uploads into one transaction, which is how services like Turbo write to Arweave. Counted over every transaction {RANGE}.',
  },
  {
    title: 'Biggest AR transfers',
    sub: 'The largest payments between wallets',
    sql: "SELECT round(quantity / 1e12, 2) AS ar,\n       strftime(mined_at, '%Y-%m-%d %H:%M') AS sent_utc,\n       tx_id\nFROM txs\nWHERE quantity > 0\nORDER BY quantity DESC\nLIMIT 10;",
    caption:
      'AR sent from one wallet to another, {RANGE}. 1 AR is 10^12 winston, the unit the chain records.',
  },
  {
    title: 'What did it store each day?',
    sub: 'Transactions, gigabytes and fees',
    sql: "SELECT strftime(mined_at, '%Y-%m-%d') AS day,\n       count(*) AS transactions,\n       round(sum(data_size) / power(2,30), 1) AS gib_stored,\n       round(sum(reward) / 1e12, 2) AS ar_in_fees\nFROM txs\nGROUP BY date_trunc('day', mined_at), day\nORDER BY date_trunc('day', mined_at);",
    caption:
      'Everything written to Arweave each day, {RANGE}. Fees are what uploaders paid the miners, in AR.',
  },
];

export const PRESETS: [string, string][] = [
  [
    'Busiest blocks',
    'SELECT height, count(*) AS txs, sum(data_size) AS bytes\nFROM txs\nGROUP BY height\nORDER BY txs DESC\nLIMIT 10;',
  ],
  [
    'Biggest uploads',
    'SELECT tx_id, height, round(data_size / power(2,20), 2) AS mib, content_type\nFROM txs\nORDER BY data_size DESC\nLIMIT 10;',
  ],
  [
    'Who stores the most',
    'SELECT owner, count(*) AS txs, round(sum(data_size) / power(2,30), 2) AS gib\nFROM txs\nGROUP BY owner\nORDER BY gib DESC\nLIMIT 10;',
  ],
  [
    'A day in the life',
    "SELECT date_trunc('day', mined_at) AS day,\n       count(*) AS txs,\n       round(sum(data_size) / power(2,30), 2) AS gib_stored,\n       round(sum(reward) / 1e12, 2) AS ar_in_fees\nFROM txs\nGROUP BY day\nORDER BY day;",
  ],
  [
    'Biggest AR transfers',
    'SELECT tx_id, owner, target, round(quantity / 1e12, 4) AS ar\nFROM txs\nWHERE quantity > 0\nORDER BY quantity DESC\nLIMIT 10;',
  ],
  [
    'What people store',
    'SELECT content_type, count(*) AS n, round(sum(data_size) / power(2,30), 2) AS gib\nFROM txs\nWHERE content_type IS NOT NULL\nGROUP BY content_type\nORDER BY n DESC\nLIMIT 15;',
  ],
  [
    'How fast are blocks',
    'SELECT round(avg(gap), 1) AS avg_seconds,\n       min(gap) AS fastest,\n       max(gap) AS slowest\nFROM (\n  SELECT epoch(mined_at) - lag(epoch(mined_at)) OVER (ORDER BY height) AS gap\n  FROM blocks\n)\nWHERE gap IS NOT NULL;',
  ],
  [
    'One wallet: history',
    "-- paste any wallet address here. unb64u() matches the stored bytes, so other\n-- columns are read only for this wallet's rows\nSELECT b64u(t.id) AS tx_id, t.height, b.mined_at, t.data_size, t.content_type\nFROM rawtx t LEFT JOIN blocks b USING (height)\nWHERE t.owner_address = unb64u('{WALLET}')\nORDER BY t.height DESC\nLIMIT 25;",
  ],
  [
    'One wallet: totals',
    "-- transactions sent and received, gigabytes stored, first and last block\nSELECT * FROM wallet_totals('{WALLET}');",
  ],
  [
    'Everything in this period',
    'SELECT count(*) AS transactions,\n       count(DISTINCT owner) AS wallets,\n       round(sum(data_size) / power(2,30), 2) AS gib,\n       min(mined_at) AS from_time,\n       max(mined_at) AS to_time\nFROM txs;',
  ],
];

export const presetSql = (i: number, sampleWallet: string | null): string =>
  PRESETS[i]![1].replaceAll('{WALLET}', sampleWallet ?? 'paste-an-address-here');

export interface BlockSpan {
  lo: number;
  hi: number;
  /** Typed as a range (`a-b`), not one height. */
  range: boolean;
}

/** The blocks a height (`2015000`) or a range (`2015000-2015100`) names, low first; null for anything else. */
export function blockSpan(raw: string): BlockSpan | null {
  const v = raw.trim();
  const range = v.match(/^(\d[\d,_]*)\s*(?:-|–|\.\.|to)\s*(\d[\d,_]*)$/i);
  if (range) {
    const a = Number(range[1]!.replace(/[,_]/g, ''));
    const b = Number(range[2]!.replace(/[,_]/g, ''));
    return { lo: Math.min(a, b), hi: Math.max(a, b), range: true };
  }
  if (/^\d[\d,_]*$/.test(v)) {
    const h = Number(v.replace(/[,_]/g, ''));
    return { lo: h, hi: h, range: false };
  }
  return null;
}

/** Turns a height or a range into SQL; 'id' for a 43-character id; null for nothing; undefined for nonsense. */
export function lookupSql(raw: string): string | 'id' | null | undefined {
  const v = raw.trim();
  if (!v) return null;
  const span = blockSpan(v);
  if (span?.range)
    return `SELECT height, mined_at, count(*) AS txs, sum(data_size) AS bytes\nFROM txs\nWHERE height BETWEEN ${span.lo} AND ${span.hi}\nGROUP BY height, mined_at\nORDER BY height;`;
  if (span)
    return `SELECT tx_id, mined_at, owner, data_size, content_type\nFROM txs\nWHERE height = ${span.lo}\nORDER BY data_size DESC;`;
  if (/^[A-Za-z0-9_-]{43}$/.test(v)) return 'id';
  return undefined;
}

export const txSql = (id: string, h: number, item: string | null): string =>
  (item
    ? `-- ${item} is a data item inside bundle ${id}. This index holds base-layer\n-- transactions, so it shows the bundle that carried it.\n`
    : '') +
  `-- The gateway says this is in block ${h}. That is only a hint: the row below is\n-- read from the signed index, so a wrong hint finds nothing, never something false.\n` +
  `SELECT t.tx_id, t.height, t.mined_at, t.owner, t.target, t.data_size, t.content_type,\n` +
  `       (SELECT left(string_agg(g.name || '=' || g.value, '  ' ORDER BY g.tag_index), 400)\n` +
  `        FROM tags g WHERE g.height = ${h} AND g.tx_id = t.tx_id) AS tags\n` +
  `FROM txs t\nWHERE t.height = ${h} AND t.tx_id = '${id}';`;

export const walletSql = (v: string, why: string): string =>
  `-- ${why}, so this looks for ${v.slice(0, 8)}… as a wallet that\n-- sent or received base-layer transactions. Over a long period that reads every\n-- band's wallet columns, a few hundred MB.\n` +
  `SELECT b64u(t.id) AS tx_id, t.height, b.mined_at,\n` +
  `       CASE WHEN t.owner_address = unb64u('${v}') THEN 'sent' ELSE 'received' END AS role,\n` +
  `       b64u(t.owner_address) AS owner, b64u(t.target) AS target, t.data_size, round(t.quantity / 1e12, 4) AS ar\n` +
  `FROM (SELECT id, height, owner_address, target, data_size, quantity FROM rawtx WHERE owner_address = unb64u('${v}')\n      UNION ALL\n      SELECT id, height, owner_address, target, data_size, quantity FROM rawtx WHERE target = unb64u('${v}')) t\n` +
  `LEFT JOIN blocks b USING (height)\nORDER BY t.height DESC\nLIMIT 100;`;

/**
 * Where Find should look for blocks, so that blocks outside the period never
 * answer "0 rows" as if they were empty. Outside everything the index holds,
 * that is said. Outside only the period: with range reads (`canWiden`) Find
 * looks over everything, as it does for an id (the height filter reads only
 * the row groups that hold it); without them, the period that holds the
 * blocks is named.
 */
export function blocksScope(
  span: BlockSpan,
  blocks: string,
  bands: readonly {
    from: number;
    to: number | null;
    fromTime?: number | null;
    toTime?: number | null;
  }[],
  [lo, hi]: [number, number],
  { canWiden }: { canWiden: boolean },
): { run: boolean; widen?: boolean; say?: string } {
  const first = bands[0];
  const last = bands[bands.length - 1];
  if (!first || !last) return { run: false };
  const tip = last.to ?? last.from;
  const is = span.range ? 'are' : 'is';
  if (span.lo > tip)
    return {
      run: false,
      say: `${blocks} ${is} newer than this index, which reaches block ${num(tip)}. The publisher adds new blocks as it updates its newest band.`,
    };
  if (span.hi < first.from)
    return {
      run: false,
      say: `${blocks} ${is} older than this index, which starts at block ${num(first.from)}.`,
    };
  if (span.hi >= lo && span.lo <= hi) return { run: true };
  if (canWiden) return { run: true, widen: true };
  const holds = bands.find((b) => span.lo <= (b.to ?? b.from) && span.hi >= b.from);
  const dates = holds ? fmtRange(holds.fromTime ?? null, holds.toTime ?? null) : null;
  return {
    run: false,
    say:
      `${blocks} ${is} outside the period chosen (blocks ${num(lo)} to ${num(hi)}). ` +
      (holds
        ? `Under Period, pick “One period…” and the one ${dates ? `from ${dates}` : `with blocks ${num(holds.from)} to ${num(holds.to ?? holds.from)}`}.`
        : 'Pick a longer period.'),
  };
}
