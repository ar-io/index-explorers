/**
 * Builds the synthetic fixtures under fixtures/synthetic: a publication
 * signed with a test key, its registry record, and three indexes:
 *
 *   ardrive-l2   two parquet-l2 bands of ArFS records (drives, folders,
 *                files) with their small JSON records under raw/, among them
 *                a drive of 20,000 files, a drive spread across both bands,
 *                private drives, several apps, versions and a hidden file.
 *                The first band is layout l2-2 (a key lookup and stats), the
 *                second l2-1, as an index is while its publisher upgrades
 *   parquet-l1   one small l1-3 band of blocks, transactions and tags
 *   root-tx-index  one cdb64 band whose partitions map the L2 items to
 *                their root transactions
 *
 * Every band has a v2 torrent; every file is listed with its size and
 * SHA-256; the publication is signed exactly as a gateway signs it. The
 * fixture gateway (tools/fixture-gateway) serves the result, so E2E runs
 * exercise the real verification paths with no network.
 *
 * Deterministic: the same inputs give the same rows, and the outputs are
 * committed so CI never depends on a DuckDB version writing identical bytes.
 *
 * Run: pnpm fixtures:build
 */
import { DuckDBInstance } from '@duckdb/node-api';
import * as ed from '@noble/ed25519';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../packages/index-client/src/util/base58.js';
import { toBase64Url } from '../packages/index-client/src/util/bytes.js';
import { buildTorrent } from '../packages/index-client/src/range/torrent.js';
import { encodeMsgpack } from '../packages/index-client/src/msgpack.js';
import { writeCdb64 } from '../packages/index-client/test/cdb64-writer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fixtures', 'synthetic');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sha256Bytes = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
// noble's synchronous signing needs a SHA-512 wired in (the browser client uses the async WebCrypto path).
ed.hashes.sha512 = (...msgs: Uint8Array[]) => {
  const h = createHash('sha512');
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
};

/* ---------- a seeded random, so the fixture is the same every build ---------- */
let seed = 0x9e3779b9;
const rand = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const bytes32 = (): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(rand() * 256);
  return b;
};
const uuid = (): string => {
  const h = Array.from(bytes32().subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/* ---------- the test publisher ---------- */
// A fixed private key: the fixture's signing key is public knowledge by design.
const PRIV = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const PUB = ed.getPublicKey(PRIV);
const KEY_ID = base58Encode(PUB);
/** The publisher's wallet, as a gateway's registry names it. */
const PUBLISHER = KEY_ID;
const PUBLISHER_TAG = 'f1x7ur3e';

/* ---------- the chain the fixture pretends ---------- */
const BANDS: [number, number][] = [
  [2000000, 2004999],
  [2005000, 2009999],
];
const TIP = 2009999;
const TIP_TIME = 1792465449; // 2026-10-19T12:24:09Z, as the real tip band's last block
const blockTime = (h: number): number => TIP_TIME - (TIP - h) * 120;

/* ---------- rows ---------- */
interface Item {
  id: Uint8Array;
  height: number;
  index: number;
  root: Uint8Array;
  owner: Uint8Array;
  size: number;
  contentType: string | null;
  tags: [string, string][];
  /** The record's JSON, when the item is an ArFS record. */
  json?: string;
  offset: number;
}
interface Wallet {
  address: Uint8Array;
  modulus: Uint8Array;
}

const items: Item[] = [];
const wallets: Wallet[] = [];
const roots = new Map<number, { id: Uint8Array; next: number; items: Item[] }>();
const walletFor = (): Wallet => {
  const modulus = new Uint8Array(512).map(() => Math.floor(rand() * 256));
  const w = { address: sha256Bytes(modulus), modulus };
  wallets.push(w);
  return w;
};
let txIndex = 0;
const rootAt = (height: number) => {
  let r = roots.get(height);
  if (!r) {
    r = { id: bytes32(), next: 0, items: [] };
    roots.set(height, r);
  }
  return r;
};
function addItem(
  height: number,
  owner: Wallet,
  tags: [string, string][],
  opts: { size?: number; json?: string; contentType?: string | null },
): Item {
  const root = rootAt(height);
  const json = opts.json;
  const size = json !== undefined ? Buffer.byteLength(json, 'utf8') : (opts.size ?? 1000);
  const contentType =
    opts.contentType === undefined
      ? json !== undefined
        ? 'application/json'
        : null
      : opts.contentType;
  const allTags: [string, string][] = contentType ? [...tags, ['Content-Type', contentType]] : tags;
  const it: Item = {
    id: bytes32(),
    height,
    index: txIndex++ % 60000,
    root: root.id,
    owner: owner.address,
    size,
    contentType,
    tags: allTags,
    offset: root.next,
  };
  if (json !== undefined) it.json = json;
  root.next += 1100 + size;
  root.items.push(it);
  items.push(it);
  return it;
}

const APPS: [string, string][] = [
  ['ArDrive-App', '2.89.0'],
  ['ArDrive-App', '2.48.2'],
  ['ArDrive-CLI', '2.0.4'],
  ['ArDrive-Core', '2.0.1'],
  ['ArDrive-Web', '2.90.1'],
  ['ArDrive-Desktop', '1.2.0'],
];
const TYPES = [
  'image/png',
  'image/jpeg',
  'video/mp4',
  'audio/mpeg',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/json',
  'text/html',
];
const WORDS = [
  'holiday',
  'invoice',
  'report',
  'photo',
  'notes',
  'backup',
  'design',
  'draft',
  'archive',
  'video',
  'music',
  'recipe',
  'map',
  'plan',
  'budget',
  'scan',
  'letter',
  'chart',
  'model',
  'sketch',
];
const name = (ext?: string) =>
  `${pick(WORDS)}-${pick(WORDS)}-${Math.floor(rand() * 1000)}${ext ? '.' + ext : ''}`;
const extOf = (t: string) =>
  ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/zip': 'zip',
    'application/json': 'json',
    'text/html': 'html',
  })[t] ?? 'bin';

const arfsTags = (
  app: [string, string],
  unixTime: number,
  extra: [string, string][],
): [string, string][] => [
  ['App-Name', app[0]],
  ['App-Version', app[1]],
  ['ArFS', '0.15'],
  ['Unix-Time', String(unixTime)],
  ...extra,
];

export const KNOWN = {
  /** The 20,000-file drive. */
  bigDrive: '' as string,
  /** A typical public drive of a few hundred records with nested folders. */
  typicalDrive: '' as string,
  /** A drive whose records span both bands. */
  wideDrive: '' as string,
  privateDrive: '' as string,
  /** The owner of the typical drive. */
  owner: '' as string,
  /** A file record id, its data id and a folder id in the typical drive. */
  fileRecord: '' as string,
  fileData: '' as string,
  folder: '' as string,
  deepFolder: '' as string,
  /** Drive and file records over both bands, as the page's counts give them. */
  drives: 0,
  files: 0,
};

/** Layout l2-2's derived tag names for the fixture: turbo-gateway.com's for ardrive-l2. */
const KEY_TAGS = ['Drive-Id', 'File-Id', 'Folder-Id', 'Parent-Folder-Id'];
const STAT_TAGS = ['App-Name', 'Content-Type', 'Entity-Type'];

interface DriveSpec {
  privacy: 'public' | 'private';
  app: [string, string];
  files: number;
  folders: number;
  depth: number;
  heights: () => number;
  owner: Wallet;
  versions?: boolean;
}

function makeDrive(spec: DriveSpec): string {
  const driveId = uuid();
  const rootFolderId = uuid();
  const h0 = spec.heights();
  const t0 = blockTime(h0);
  const priv: [string, string][] =
    spec.privacy === 'private'
      ? [
          ['Drive-Privacy', 'private'],
          ['Cipher', 'AES256-GCM'],
          ['Cipher-IV', 'abc'],
        ]
      : [['Drive-Privacy', 'public']];
  const dname = name();
  addItem(
    h0,
    spec.owner,
    arfsTags(spec.app, t0, [['Entity-Type', 'drive'], ['Drive-Id', driveId], ...priv]),
    {
      json:
        spec.privacy === 'private' ? 'x'.repeat(96) : JSON.stringify({ name: dname, rootFolderId }),
      contentType: spec.privacy === 'private' ? 'application/octet-stream' : 'application/json',
    },
  );
  const folderIds: string[] = [rootFolderId];
  const folderDepth = new Map<string, number>([[rootFolderId, 0]]);
  addItem(
    h0,
    spec.owner,
    arfsTags(spec.app, t0, [
      ['Entity-Type', 'folder'],
      ['Drive-Id', driveId],
      ['Folder-Id', rootFolderId],
      ...(spec.privacy === 'private' ? [['Cipher', 'AES256-GCM'] as [string, string]] : []),
    ]),
    {
      json: spec.privacy === 'private' ? 'x'.repeat(64) : JSON.stringify({ name: dname }),
      contentType: spec.privacy === 'private' ? 'application/octet-stream' : 'application/json',
    },
  );
  for (let i = 0; i < spec.folders; i++) {
    const parents = folderIds.filter((f) => folderDepth.get(f)! < spec.depth);
    const parent = pick(parents.length ? parents : [rootFolderId]);
    const id = uuid();
    folderIds.push(id);
    folderDepth.set(id, folderDepth.get(parent)! + 1);
    const h = spec.heights();
    addItem(
      h,
      spec.owner,
      arfsTags(spec.app, blockTime(h), [
        ['Entity-Type', 'folder'],
        ['Drive-Id', driveId],
        ['Folder-Id', id],
        ['Parent-Folder-Id', parent],
        ...(spec.privacy === 'private' ? [['Cipher', 'AES256-GCM'] as [string, string]] : []),
      ]),
      {
        json: spec.privacy === 'private' ? 'x'.repeat(64) : JSON.stringify({ name: name() }),
        contentType: spec.privacy === 'private' ? 'application/octet-stream' : 'application/json',
      },
    );
    if (i === 1 && !KNOWN.folder && spec.files > 100 && spec.files < 1000) KNOWN.folder = id;
    if (folderDepth.get(id) === 2 && !KNOWN.deepFolder && spec.files > 100 && spec.files < 1000)
      KNOWN.deepFolder = id;
  }
  for (let i = 0; i < spec.files; i++) {
    const parent = pick(folderIds);
    const fileId = uuid();
    const h = spec.heights();
    const t = blockTime(h);
    const type = pick(TYPES);
    const size = Math.floor(Math.exp(rand() * 14)) + 100;
    const data = addItem(
      h,
      spec.owner,
      [
        ['App-Name', spec.app[0]],
        ['App-Version', spec.app[1]],
        ...(spec.privacy === 'private' ? [['Cipher', 'AES256-GCM'] as [string, string]] : []),
      ],
      {
        size,
        contentType: spec.privacy === 'private' ? 'application/octet-stream' : type,
      },
    );
    const meta = {
      name: name(extOf(type)),
      size,
      lastModifiedDate: t * 1000 - Math.floor(rand() * 1e9),
      dataTxId: toBase64Url(data.id),
      dataContentType: type,
    };
    const hidden: [string, string][] = i === 7 ? [['Is-Hidden', 'true']] : [];
    const rec = addItem(
      h,
      spec.owner,
      arfsTags(spec.app, t, [
        ['Entity-Type', 'file'],
        ['Drive-Id', driveId],
        ['File-Id', fileId],
        ['Parent-Folder-Id', parent],
        ...hidden,
        ...(spec.privacy === 'private' ? [['Cipher', 'AES256-GCM'] as [string, string]] : []),
      ]),
      {
        json: spec.privacy === 'private' ? 'x'.repeat(128) : JSON.stringify(meta),
        contentType: spec.privacy === 'private' ? 'application/octet-stream' : 'application/json',
      },
    );
    if (i === 3 && spec.files > 100 && spec.files < 1000 && !KNOWN.fileRecord) {
      KNOWN.fileRecord = toBase64Url(rec.id);
      KNOWN.fileData = toBase64Url(data.id);
    }
    // A rename: a second version of the same File-Id, later.
    if (spec.versions && i % 50 === 5) {
      const h2 = Math.min(TIP, h + 3);
      addItem(
        h2,
        spec.owner,
        arfsTags(spec.app, blockTime(h2), [
          ['Entity-Type', 'file'],
          ['Drive-Id', driveId],
          ['File-Id', fileId],
          ['Parent-Folder-Id', parent],
        ]),
        {
          json: JSON.stringify({ ...meta, name: 'renamed-' + meta.name }),
        },
      );
    }
  }
  return driveId;
}

function generate(): void {
  const heightsIn = (lo: number, hi: number) => () => lo + Math.floor(rand() * (hi - lo + 1));
  const near = (h: number, spread: number) => () =>
    Math.max(BANDS[0]![0], Math.min(TIP, h + Math.floor(rand() * spread)));
  const mainOwner = walletFor();
  // 60 small drives spread over both bands, newest first in the browse view.
  const owners = Array.from({ length: 12 }, walletFor);
  for (let i = 0; i < 60; i++) {
    const h = BANDS[0]![0] + Math.floor((i / 60) * (TIP - BANDS[0]![0]));
    const privacy = i % 4 === 3 ? 'private' : 'public';
    makeDrive({
      privacy,
      app: pick(APPS),
      files: 2 + Math.floor(rand() * 12),
      folders: Math.floor(rand() * 3),
      depth: 2,
      heights: near(h, 20),
      owner: pick(owners),
    });
  }
  // The typical drive: 549 records, nested folders, versions, a hidden file.
  KNOWN.typicalDrive = makeDrive({
    privacy: 'public',
    app: APPS[0]!,
    files: 270,
    folders: 6,
    depth: 3,
    heights: near(TIP - 60, 6),
    owner: mainOwner,
    versions: true,
  });
  KNOWN.owner = toBase64Url(mainOwner.address);
  // The 20,000-file drive: 40 folders, two levels, in a tight window.
  KNOWN.bigDrive = makeDrive({
    privacy: 'public',
    app: APPS[1]!,
    files: 20000,
    folders: 40,
    depth: 2,
    heights: near(TIP - 500, 40),
    owner: walletFor(),
  });
  // The wide drive: records across both bands, 9,000 blocks apart.
  KNOWN.wideDrive = makeDrive({
    privacy: 'public',
    app: APPS[2]!,
    files: 120,
    folders: 3,
    depth: 2,
    heights: heightsIn(BANDS[0]![0] + 100, TIP - 100),
    owner: walletFor(),
  });
  KNOWN.privateDrive = makeDrive({
    privacy: 'private',
    app: APPS[0]!,
    files: 40,
    folders: 4,
    depth: 2,
    heights: near(TIP - 200, 10),
    owner: mainOwner,
  });
  // Some non-ArDrive-looking but selected uploads (App-Name ArDrive-Sync) with big files, for the questions.
  const sync = walletFor();
  for (let i = 0; i < 30; i++)
    addItem(
      heightsIn(BANDS[1]![0], TIP)(),
      sync,
      [
        ['App-Name', 'ArDrive-Sync'],
        ['App-Version', '0.1.0'],
      ],
      { size: 50_000_000 + Math.floor(rand() * 400_000_000), contentType: 'video/mp4' },
    );
}

/* ---------- writing parquet with DuckDB ---------- */
async function writeBands(): Promise<
  Record<
    string,
    {
      dir: string;
      files: { name: string; bytes: Uint8Array }[];
      records: number;
      from: number;
      to: number;
    }
  >
> {
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  // Items and tags as CSV-ish inserts through a staging table.
  await c.run(
    `CREATE TABLE items (id BLOB, height UBIGINT, block_transaction_index USMALLINT, root_transaction_id BLOB, parent_id BLOB, owner_address BLOB, target BLOB, anchor BLOB, signature_type UTINYINT, data_size UBIGINT, content_type VARCHAR, content_encoding VARCHAR, tag_count INTEGER, root_parent_offset UBIGINT, "offset" UBIGINT, size UBIGINT, data_offset UBIGINT, owner_offset UBIGINT, owner_size UBIGINT, signature_offset UBIGINT, signature_size UBIGINT)`,
  );
  await c.run(
    `CREATE TABLE tags (height UBIGINT, id BLOB, tag_index USMALLINT, tag_name BLOB, tag_value BLOB)`,
  );
  await c.run(`CREATE TABLE wallets (address BLOB, public_modulus BLOB)`);
  const esc = (s: string) => s.replace(/'/g, "''");
  const batches: string[] = [];
  let cur: string[] = [];
  for (const it of items) {
    cur.push(
      `(from_hex('${hex(it.id)}'), ${it.height}, ${it.index}, from_hex('${hex(it.root)}'), from_hex('${hex(it.root)}'), from_hex('${hex(it.owner)}'), NULL, NULL, 1, ${it.size}, ${it.contentType ? `'${esc(it.contentType)}'` : 'NULL'}, NULL, ${it.tags.length}, 0, ${it.offset}, ${it.size + 1100}, ${it.offset + 1100}, ${it.offset + 2}, 512, ${it.offset + 514}, 512)`,
    );
    if (cur.length >= 2000) {
      batches.push(cur.join(','));
      cur = [];
    }
  }
  if (cur.length) batches.push(cur.join(','));
  for (const b of batches) await c.run(`INSERT INTO items VALUES ${b}`);
  cur = [];
  const tagBatches: string[] = [];
  for (const it of items) {
    it.tags.forEach(([k, v], i) => {
      cur.push(
        `(${it.height}, from_hex('${hex(it.id)}'), ${i}, '${esc(k)}'::BLOB, '${esc(v)}'::BLOB)`,
      );
    });
    if (cur.length >= 4000) {
      tagBatches.push(cur.join(','));
      cur = [];
    }
  }
  if (cur.length) tagBatches.push(cur.join(','));
  for (const b of tagBatches) await c.run(`INSERT INTO tags VALUES ${b}`);
  for (const w of wallets)
    await c.run(
      `INSERT INTO wallets VALUES (from_hex('${hex(w.address)}'), from_hex('${hex(w.modulus)}'))`,
    );

  const prefix64 = (col: string) => `('0x' || rpad(left(hex(${col}), 16), 16, '0'))::UBIGINT`;
  const sha64 = (col: string) => `('0x' || left(sha256(${col}), 16))::UBIGINT`;
  const out: Record<
    string,
    {
      dir: string;
      files: { name: string; bytes: Uint8Array }[];
      records: number;
      from: number;
      to: number;
    }
  > = {};
  for (const [from, to] of BANDS) {
    const tmp = path.join(OUT, '_tmp');
    mkdirSync(tmp, { recursive: true });
    const where = `height BETWEEN ${from} AND ${to}`;
    const copy = async (file: string, sql: string, rowGroup = 122880) =>
      c.run(
        `COPY (${sql}) TO '${path.join(tmp, file)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${rowGroup})`,
      );
    await copy(
      'data_items.parquet',
      `SELECT * FROM items WHERE ${where} ORDER BY height, block_transaction_index, id, root_parent_offset, "offset"`,
    );
    await copy('tags.parquet', `SELECT * FROM tags WHERE ${where} ORDER BY height, id, tag_index`);
    await copy(
      'wallets.parquet',
      `SELECT * FROM wallets WHERE address IN (SELECT owner_address FROM items WHERE ${where}) ORDER BY address`,
    );
    await copy(
      'parents.parquet',
      `SELECT NULL::BLOB AS id, NULL::BLOB AS root_transaction_id, NULL::UBIGINT AS root_parent_offset, NULL::UBIGINT AS "offset", NULL::UBIGINT AS size, NULL::UBIGINT AS data_offset WHERE false`,
    );
    await copy(
      'lookup_id.parquet',
      `SELECT ${prefix64('id')} AS id8, height FROM (SELECT DISTINCT id, height FROM items WHERE ${where}) ORDER BY id8, height`,
      16384,
    );
    await copy(
      'lookup_wallet.parquet',
      `WITH i AS (SELECT DISTINCT id, height, owner_address, target, data_size FROM items WHERE ${where})
       SELECT * FROM (SELECT ${prefix64('owner_address')} AS addr8, 0::UTINYINT AS role, height, data_size FROM i WHERE owner_address IS NOT NULL
       UNION ALL SELECT ${prefix64('target')}, 1::UTINYINT, height, data_size FROM i WHERE target IS NOT NULL AND octet_length(target) > 0)
       ORDER BY addr8, height, role, data_size`,
      16384,
    );
    await copy(
      'lookup_tag.parquet',
      `SELECT ${sha64('tag_name')} AS name8, ${sha64('tag_value')} AS val8, tag_name AS name, tag_value AS value,
              count(DISTINCT id)::UBIGINT AS txs, min(height) AS first_height, max(height) AS last_height
       FROM tags WHERE ${where} GROUP BY tag_name, tag_value ORDER BY name8, val8, name, value`,
      16384,
    );
    const l2v2 = from === BANDS[0]![0];
    const tagIn = (names: string[]) =>
      `tag_name IN (${names.map((n) => `'${esc(n)}'::BLOB`).join(',')})`;
    if (l2v2) {
      // As ar-io-node's keyLookup and statsLookup (src/lib/parquet-l2/layout.ts).
      await copy(
        'lookup_key.parquet',
        `SELECT name8, val8, height, count(*)::UBIGINT AS items
         FROM (SELECT DISTINCT ${sha64('tag_name')} AS name8, ${sha64('tag_value')} AS val8, height, id
               FROM tags WHERE ${where} AND ${tagIn(KEY_TAGS)})
         GROUP BY name8, val8, height ORDER BY name8, val8, height`,
        16384,
      );
      const bucket = `((height // 1000) * 1000)::UBIGINT`;
      await copy(
        'stats.parquet',
        `WITH it AS (SELECT DISTINCT id, height, data_size FROM items WHERE ${where}),
         first_index AS (
           SELECT height, id, tag_name, min(tag_index) AS tag_index FROM tags
           WHERE ${where} AND ${tagIn(STAT_TAGS)} GROUP BY height, id, tag_name),
         picked AS (
           SELECT f.height, f.id, f.tag_name AS name, t.tag_value AS value
           FROM first_index f JOIN tags t ON t.height = f.height AND t.id = f.id AND t.tag_index = f.tag_index)
         SELECT * FROM (
           SELECT ${bucket} AS bucket, ''::BLOB AS name, ''::BLOB AS value, count(*)::UBIGINT AS items,
                  coalesce(sum(data_size), 0)::UBIGINT AS bytes FROM it GROUP BY 1
           UNION ALL
           SELECT ${bucket} AS bucket, name, value, count(*)::UBIGINT AS items,
                  coalesce(sum(data_size), 0)::UBIGINT AS bytes FROM it JOIN picked USING (height, id) GROUP BY 1, 2, 3)
         ORDER BY bucket, name, value`,
        16384,
      );
    }
    const rows = async (sql: string) =>
      Number(((await c.runAndReadAll(sql)).getRowObjects()[0] as { n: unknown }).n);
    const records = await rows(`SELECT count(*) AS n FROM items WHERE ${where}`);
    for (const kind of ['drive', 'file'] as const)
      KNOWN[kind === 'drive' ? 'drives' : 'files'] += await rows(
        `SELECT count(DISTINCT id) AS n FROM tags WHERE ${where} AND tag_name = 'Entity-Type'::BLOB AND tag_value = '${kind}'::BLOB`,
      );
    const derived = async (file: string) =>
      Number(
        (
          (
            await c.runAndReadAll(
              `SELECT count(*) AS n FROM read_parquet('${path.join(tmp, file)}')`,
            )
          ).getRowObjects()[0] as { n: unknown }
        ).n,
      );
    const band = {
      version: 1,
      schema: l2v2 ? 'l2-2' : 'l2-1',
      heightRange: [from, to],
      selection: {
        kind: 'ans104-data-items',
        tag: { name: 'App-Name', valuePrefix: 'ArDrive', excludeValuePrefix: 'ArDriver' },
      },
      tables: {
        data_items: { rows: records, rowDigest: '0'.repeat(64) },
        tags: {
          rows: await rows(`SELECT count(*) AS n FROM tags WHERE ${where}`),
          rowDigest: '0'.repeat(64),
        },
        wallets: {
          rows: await rows(
            `SELECT count(*) AS n FROM wallets WHERE address IN (SELECT owner_address FROM items WHERE ${where})`,
          ),
          rowDigest: '0'.repeat(64),
        },
        parents: {
          rows: 0,
          rowDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      },
      lookups: {
        id: { rows: records, rowDigest: '0'.repeat(64) },
        wallet: { rows: records, rowDigest: '0'.repeat(64) },
        tag: {
          rows: await rows(
            `SELECT count(*) AS n FROM (SELECT DISTINCT tag_name, tag_value FROM tags WHERE ${where})`,
          ),
          rowDigest: '0'.repeat(64),
        },
        ...(l2v2
          ? {
              key: { rows: await derived('lookup_key.parquet'), rowDigest: '0'.repeat(64) },
              stats: { rows: await derived('stats.parquet'), rowDigest: '0'.repeat(64) },
            }
          : {}),
      },
      ...(l2v2 ? { keyTags: KEY_TAGS, statTags: STAT_TAGS } : {}),
      checks: { fixture: true },
      createdAt: new Date(blockTime(to) * 1000).toISOString(),
    };
    const files: { name: string; bytes: Uint8Array }[] = [
      { name: 'band.json', bytes: new TextEncoder().encode(JSON.stringify(band, null, 2) + '\n') },
    ];
    for (const f of [
      'data_items.parquet',
      'tags.parquet',
      'wallets.parquet',
      'parents.parquet',
      'lookup_id.parquet',
      'lookup_wallet.parquet',
      'lookup_tag.parquet',
      ...(l2v2 ? ['lookup_key.parquet', 'stats.parquet'] : []),
    ])
      files.push({ name: f, bytes: new Uint8Array(readFileSync(path.join(tmp, f))) });
    const digest = sha256(
      new TextEncoder().encode(JSON.stringify([from, to]) + '\n' + JSON.stringify(band.selection)),
    ).slice(0, 12);
    const id = `l2-h${from}-${to}-${PUBLISHER_TAG}-${digest}`;
    out[id] = { dir: path.join(OUT, 'ardrive-l2', id), files, records, from, to };
    rmSync(tmp, { recursive: true, force: true });
  }

  // An L1 band of the second range: blocks, transactions (one per root), tags, lookups.
  {
    const [from, to] = BANDS[1]!;
    const tmp = path.join(OUT, '_tmp');
    mkdirSync(tmp, { recursive: true });
    await c.run(
      `CREATE TABLE blocks AS SELECT h AS height, from_hex(sha256(('b' || h)::BLOB)) AS indep_hash, from_hex(sha256(('p' || h)::BLOB)) AS previous_block, ''::BLOB AS nonce, ''::BLOB AS hash, (${TIP_TIME} - (${TIP} - h) * 120)::BIGINT AS block_timestamp, 0::INTEGER AS tx_count, 0::UBIGINT AS block_size, '1'::VARCHAR AS diff, '1'::VARCHAR AS cumulative_diff, 0::BIGINT AS last_retarget, NULL::BLOB AS reward_addr, '0'::VARCHAR AS reward_pool, (h * 1000000)::UBIGINT AS weave_size, 1::BIGINT AS usd_to_ar_rate_dividend, 1::BIGINT AS usd_to_ar_rate_divisor, 1::BIGINT AS scheduled_usd_to_ar_rate_dividend, 1::BIGINT AS scheduled_usd_to_ar_rate_divisor, ''::BLOB AS hash_list_merkle, ''::BLOB AS wallet_list, ''::BLOB AS tx_root FROM range(${from}, ${to + 1}) t(h)`,
    );
    const txRows: string[] = [];
    const txTagRows: string[] = [];
    let ti = 0;
    for (const [h, r] of roots) {
      if (h < from || h > to) continue;
      const owner = r.items[0]!.owner;
      const size = r.items.reduce((t, i) => t + i.size + 1100, 0);
      txRows.push(
        `(from_hex('${hex(r.id)}'), ${ti % 1000}, false, NULL, 0, ${1000000 + (ti % 7) * 12345}, NULL, ${size}, 'application/x.arweave-manifest+json', 2, ${h}, from_hex('${hex(owner)}'), from_hex('${hex(r.id)}'), ${ti * 1000}, NULL, 3, NULL)`,
      );
      txTagRows.push(
        `(${h}, from_hex('${hex(r.id)}'), 0, 'Bundle-Format'::BLOB, 'binary'::BLOB, false)`,
        `(${h}, from_hex('${hex(r.id)}'), 1, 'Bundle-Version'::BLOB, '2.0.0'::BLOB, false)`,
        `(${h}, from_hex('${hex(r.id)}'), 2, 'App-Name'::BLOB, '${pick(['Turbo', 'ArDrive', 'Bundlr'])}'::BLOB, false)`,
      );
      ti++;
    }
    await c.run(
      `CREATE TABLE l1tx (id BLOB, block_transaction_index USMALLINT, is_data_item BOOLEAN, target BLOB, quantity DECIMAL(20,0), reward DECIMAL(20,0), anchor BLOB, data_size UBIGINT, content_type VARCHAR, format UTINYINT, height UBIGINT, owner_address BLOB, data_root BLOB, "offset" UBIGINT, content_encoding VARCHAR, tag_count INTEGER, signature BLOB)`,
    );
    await c.run(`INSERT INTO l1tx VALUES ${txRows.join(',')}`);
    await c.run(
      `CREATE TABLE l1tags (height UBIGINT, id BLOB, tag_index USMALLINT, tag_name BLOB, tag_value BLOB, is_data_item BOOLEAN)`,
    );
    await c.run(`INSERT INTO l1tags VALUES ${txTagRows.join(',')}`);
    const copy = async (file: string, sql: string, rowGroup = 122880) =>
      c.run(
        `COPY (${sql}) TO '${path.join(tmp, file)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${rowGroup})`,
      );
    await copy('blocks.parquet', `SELECT * FROM blocks ORDER BY height`);
    await copy(
      'block_transactions.parquet',
      `SELECT height, block_transaction_index, id AS transaction_id FROM l1tx ORDER BY height, block_transaction_index`,
    );
    await copy(
      'transactions.parquet',
      `SELECT * FROM l1tx ORDER BY height, block_transaction_index`,
    );
    await copy('tags.parquet', `SELECT * FROM l1tags ORDER BY height, id, tag_index`);
    await copy(
      'wallets.parquet',
      `SELECT * FROM wallets WHERE address IN (SELECT owner_address FROM l1tx) ORDER BY address`,
    );
    await copy(
      'lookup_tx_id.parquet',
      `SELECT ${prefix64('id')} AS id8, height FROM l1tx ORDER BY id8, height`,
      16384,
    );
    await copy(
      'lookup_wallet.parquet',
      `SELECT ${prefix64('owner_address')} AS addr8, 0::UTINYINT AS role, height, data_size FROM l1tx ORDER BY addr8, height, role, data_size`,
      16384,
    );
    await copy(
      'lookup_tag.parquet',
      `SELECT ${sha64('tag_name')} AS name8, ${sha64('tag_value')} AS val8, tag_name AS name, tag_value AS value, count(DISTINCT id)::UBIGINT AS txs, min(height) AS first_height, max(height) AS last_height FROM l1tags GROUP BY tag_name, tag_value ORDER BY name8, val8, name, value`,
      16384,
    );
    const band = {
      version: 1,
      schema: 'l1-3',
      heightRange: [from, to],
      tables: {
        blocks: { rows: to - from + 1, rowDigest: '0'.repeat(64) },
        block_transactions: { rows: txRows.length, rowDigest: '0'.repeat(64) },
        transactions: { rows: txRows.length, rowDigest: '0'.repeat(64) },
        tags: { rows: txTagRows.length, rowDigest: '0'.repeat(64) },
        wallets: { rows: 0, rowDigest: '0'.repeat(64) },
      },
      lookups: {
        tx_id: { rows: txRows.length, rowDigest: '0'.repeat(64) },
        wallet: { rows: txRows.length, rowDigest: '0'.repeat(64) },
        tag: { rows: 0, rowDigest: '0'.repeat(64) },
      },
      createdAt: new Date(blockTime(to) * 1000).toISOString(),
    };
    const files: { name: string; bytes: Uint8Array }[] = [
      { name: 'band.json', bytes: new TextEncoder().encode(JSON.stringify(band, null, 2) + '\n') },
    ];
    for (const f of [
      'blocks.parquet',
      'block_transactions.parquet',
      'transactions.parquet',
      'tags.parquet',
      'wallets.parquet',
      'lookup_tx_id.parquet',
      'lookup_wallet.parquet',
      'lookup_tag.parquet',
    ])
      files.push({ name: f, bytes: new Uint8Array(readFileSync(path.join(tmp, f))) });
    const id = `l1-h${from}-${to}-${PUBLISHER_TAG}-${sha256(new TextEncoder().encode('l1' + from)).slice(0, 12)}`;
    out[id] = { dir: path.join(OUT, 'parquet-l1', id), files, records: txRows.length, from, to };
    rmSync(tmp, { recursive: true, force: true });
  }
  c.closeSync();
  return out;
}

/* ---------- the root-tx band: cdb64 partitions over the L2 items ---------- */
function buildRootTxBand(): {
  files: { name: string; bytes: Uint8Array }[];
  records: number;
  from: number;
  to: number;
} {
  const byPrefix = new Map<number, { key: Uint8Array; value: Uint8Array }[]>();
  for (const it of items) {
    const list = byPrefix.get(it.id[0]!) ?? [];
    list.push({
      key: it.id,
      value: encodeMsgpack({ r: it.root, i: it.offset, d: it.offset + 1100, s: it.size + 1100 }),
    });
    byPrefix.set(it.id[0]!, list);
  }
  const files: { name: string; bytes: Uint8Array }[] = [];
  const partitions: unknown[] = [];
  for (const p of [...byPrefix.keys()].sort((a, b) => a - b)) {
    const recs = byPrefix.get(p)!;
    const bytes = writeCdb64(recs);
    const filename = p.toString(16).padStart(2, '0') + '.cdb';
    files.push({ name: filename, bytes });
    partitions.push({
      prefix: p.toString(16).padStart(2, '0'),
      location: { type: 'file', filename },
      recordCount: recs.length,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const manifest = {
    version: 1,
    createdAt: new Date(TIP_TIME * 1000).toISOString(),
    totalRecords: items.length,
    partitions,
    metadata: { heightRange: [BANDS[0]![0], TIP] },
  };
  files.unshift({
    name: 'manifest.json',
    bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'),
  });
  return { files, records: items.length, from: BANDS[0]![0], to: TIP };
}

/* ---------- the publication ---------- */
async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(path.join(OUT, 'torrents'), { recursive: true });
  generate();
  console.log(`generated ${items.length} items, ${roots.size} roots, ${wallets.length} wallets`);
  // Every record's JSON in one file (twenty thousand tiny files would weigh on git and the filesystem),
  // by id so a rebuild writes the same bytes.
  const raw: Record<string, string> = {};
  for (const [id, json] of items
    .filter((it) => it.json !== undefined)
    .map((it) => [toBase64Url(it.id), it.json!] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    raw[id] = json;
  writeFileSync(path.join(OUT, 'raw.json'), JSON.stringify(raw) + '\n');
  const bands = await writeBands();
  const rt = buildRootTxBand();
  const rtId = `d-h${rt.from}-${rt.to}-${PUBLISHER_TAG}-${sha256(new TextEncoder().encode('rt')).slice(0, 12)}`;
  bands[rtId] = { dir: path.join(OUT, 'root-tx-index', rtId), ...rt };

  const indexes: Record<string, { kind: string; bands: unknown[]; filter?: unknown }> = {
    'root-tx-index': { kind: 'cdb64-root-tx', bands: [] },
    'parquet-l1': { kind: 'parquet-l1', bands: [] },
    'ardrive-l2': {
      kind: 'parquet-l2',
      bands: [],
      filter: {
        kind: 'ans104-data-items',
        tag: { name: 'App-Name', valuePrefix: 'ArDrive', excludeValuePrefix: 'ArDriver' },
      },
    },
  };
  for (const [id, b] of Object.entries(bands)) {
    mkdirSync(b.dir, { recursive: true });
    for (const f of b.files) writeFileSync(path.join(b.dir, f.name), f.bytes);
    const { bytes: torrent, infohashV2 } = await buildTorrent(b.files, { name: id.slice(0, 16) });
    const infohashV1 = createHash('sha1').update(torrent).digest('hex');
    writeFileSync(path.join(OUT, 'torrents', `${infohashV1}.torrent`), torrent);
    const index = id.startsWith('l2-')
      ? 'ardrive-l2'
      : id.startsWith('l1-')
        ? 'parquet-l1'
        : 'root-tx-index';
    const metadata = id.startsWith('l2-')
      ? { schema: 'l2-1', selection: indexes['ardrive-l2']!.filter }
      : id.startsWith('l1-')
        ? { schema: 'l1-3' }
        : {};
    indexes[index]!.bands.push({
      id,
      heightRange: [b.from, b.to],
      records: b.records,
      http: { baseUrl: `/ar-io/indexes/${index}/${id}/` },
      files: b.files
        .map((f) => ({ name: f.name, size: f.bytes.length, sha256: sha256(f.bytes) }))
        .sort((x, y) => (x.name < y.name ? -1 : 1)),
      torrent: {
        infohashV1,
        infohashV2,
        magnet: `magnet:?xt=urn:btih:${infohashV1}&xt=urn:btmh:1220${infohashV2}`,
        torrentUrl: `/ar-io/indexes/torrents/${infohashV1}.torrent`,
      },
      metadata,
    });
  }
  const unsigned = {
    version: 1,
    publisher: PUBLISHER,
    sequence: 7,
    previousManifestSha256: null,
    issuedAt: new Date(TIP_TIME * 1000).toISOString(),
    // Far in the future: a fixture must not go stale.
    expiresAt: '2099-01-01T00:00:00.000Z',
    indexes: Object.entries(indexes).map(([name, ix]) => ({ name, ...ix })),
  };
  const base = new TextEncoder().encode('ar-io-index-publication/v1\n' + canonicalize(unsigned));
  const sig = ed.sign(base, PRIV);
  const doc = {
    ...unsigned,
    signature: { alg: 'ed25519', keyId: KEY_ID, sig: Buffer.from(sig).toString('base64') },
  };
  writeFileSync(path.join(OUT, 'publication.json'), JSON.stringify(doc, null, 2) + '\n');
  const peers = {
    gateways: {
      'fixture-gateway.invalid:443': {
        url: 'https://fixture-gateway.invalid',
        wallet: PUBLISHER,
        observerAddress: KEY_ID,
        operatorStake: 1,
        status: 'joined',
      },
    },
  };
  writeFileSync(path.join(OUT, 'peers.json'), JSON.stringify(peers, null, 2) + '\n');
  const blocks: Record<string, number> = {};
  for (const [from, to] of BANDS) {
    blocks[from] = blockTime(from);
    blocks[to] = blockTime(to);
  }
  writeFileSync(path.join(OUT, 'blocks.json'), JSON.stringify(blocks, null, 2) + '\n');
  writeFileSync(
    path.join(OUT, 'known.json'),
    JSON.stringify(
      { ...KNOWN, publisher: PUBLISHER, keyId: KEY_ID, tip: TIP, bands: BANDS },
      null,
      2,
    ) + '\n',
  );
  console.log('wrote', OUT);
  console.log(KNOWN);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
