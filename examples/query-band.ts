/**
 * SQL over one verified band of a parquet index, from Node.
 *
 *   pnpm example:query l1 [sql] [--band <id>] [--gateway <url>]
 *   pnpm example:query ardrive [sql] [--band <id>] [--gateway <url>]
 *
 * `l1` reads the `parquet-l1` index (every base-layer transaction); `ardrive`
 * reads the `parquet-l2` index that selects ArDrive's data items, found by
 * what it selects rather than by its name. The newest band is used unless
 * `--band` names another. With no SQL, a few example questions run.
 *
 * The checks:
 *   1. the publication's signature, against the registry read through another gateway
 *   2. every file read, whole, against the SHA-256 that signed publication lists for it
 *
 * Whole files suit Node: the newest band is under 10 MB. A page reads ranges
 * instead, each checked against the band's torrent (see lookup-root.ts and the
 * client's service worker), so a question costs only the row groups it needs.
 *
 * The SQL is the client's layout SQL, the same text the pages run in
 * DuckDB-WASM; here it runs in native DuckDB over the downloaded files.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  arfs,
  type Band,
  fetchPublication,
  parquetL1,
  parquetL2,
  REGISTRY_GATEWAYS,
  selectIndex,
  sha256Hex,
  verifyPublication,
} from '../packages/index-client/src/index.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const bandId = flag('--band');
const gateway = flag('--gateway') ?? 'https://turbo-gateway.com';
const [which, sql] = args;
if (which !== 'l1' && which !== 'ardrive') {
  console.error('usage: pnpm example:query <l1|ardrive> [sql] [--band <id>] [--gateway <url>]');
  process.exit(2);
}

// 1. The publication, verified.
const pub = await fetchPublication(gateway);
const proof = await verifyPublication(pub.doc, {
  registryGateways: REGISTRY_GATEWAYS,
  excluding: pub.gateway,
});
console.log(
  `publication #${pub.doc.sequence} by ${pub.doc.publisher}: verified against the registry read through ${proof.via}`,
);

// 2. The index: L1 by its name; an L2 index by its selection.
let indexName = 'parquet-l1';
if (which === 'ardrive') {
  const found = parquetL2.findL2Index(pub.doc, arfs.ARDRIVE_SELECTION, 'ardrive-l2');
  if (found.name === null) throw new Error(found.why);
  indexName = found.name;
  console.log(
    `${indexName} selects ${parquetL2.describeL2Selection(arfs.ARDRIVE_SELECTION)}, as asked`,
  );
}
const { bands } = selectIndex(pub.doc, indexName, { gateway: pub.gateway });
const band = bandId ? bands.find((b) => b.id === bandId) : bands[bands.length - 1];
if (!band) throw new Error(`${indexName} has no band ${bandId}`);
const to = band.to ?? band.from;
console.log(
  `band ${band.id}: blocks ${band.from.toLocaleString()} to ${to.toLocaleString()}, ${band.records.toLocaleString()} records`,
);

// 3. The files the layout reads, each checked against its signed SHA-256.
const dir = mkdtempSync(path.join(tmpdir(), 'index-band-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
async function download(b: Band, file: string): Promise<string> {
  const f = b.files.get(file);
  if (!f) throw new Error(`${b.id} has no ${file}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== f.size || (await sha256Hex(bytes)) !== f.sha256)
    throw new Error(`${file} does not match the SHA-256 the publication signs: refused`);
  const out = path.join(dir, file);
  writeFileSync(out, bytes);
  console.log(`  ${file}: ${(f.size / 1e6).toFixed(1)} MB, SHA-256 matches the publication`);
  return out;
}
async function namesFor<K extends string>(files: Record<K, string>, kinds: readonly K[]) {
  const names: Partial<Record<K, string>> = {};
  for (const k of kinds) if (band!.files.has(files[k])) names[k] = await download(band!, files[k]);
  return names;
}

// 4. The layout's views and macros, then the questions.
const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
const run = async (statements: string[]) => {
  for (const s of statements) await c.run(s);
};
let questions: string[];
if (which === 'l1') {
  const kinds = [...parquetL1.L1_TABLE_KINDS, ...parquetL1.L1_LOOKUP_KINDS];
  const reg = {
    id: band.id,
    from: band.from,
    to,
    names: await namesFor(parquetL1.L1_FILES, kinds),
  };
  const period = parquetL1.l1PeriodSql([reg]);
  await run(period.first);
  const [h] = (
    await c.runAndReadAll('SELECT min(height) AS lo, max(height) AS hi FROM blocks')
  ).getRowObjects() as { lo: number; hi: number }[];
  await run(period.second(Number(h!.lo), Number(h!.hi)));
  const [t] = (
    await c.runAndReadAll('SELECT tx_id FROM txs ORDER BY height DESC LIMIT 1')
  ).getRowObjects() as { tx_id: string }[];
  questions = [
    'SELECT count(*) AS transactions, count(DISTINCT owner) AS wallets, round(sum(data_size) / power(2,30), 2) AS gib FROM txs',
    "SELECT value AS app, transactions FROM tag_counts('App-Name') ORDER BY transactions DESC LIMIT 5",
    // find_tx reads the lookup file for the block first, then that block's rows
    `SELECT tx_id, height, mined_at, owner, data_size, content_type FROM find_tx('${t!.tx_id}')`,
  ];
} else {
  const kinds = [...parquetL2.L2_TABLE_KINDS, ...parquetL2.L2_LOOKUP_KINDS];
  const reg = {
    id: band.id,
    from: band.from,
    to,
    names: await namesFor(parquetL2.L2_FILES, kinds),
  };
  await run(parquetL2.l2BaseSql([reg]));
  await run(parquetL2.l2PeriodViewsSql([reg], band.from, to));
  await run(arfs.arfsBaseSql([reg]));
  await run(arfs.arfsPeriodViewsSql([reg], band.from, to));
  questions = [
    'SELECT count(*) AS items, count(DISTINCT owner) AS wallets, round(sum(data_size) / power(2,30), 2) AS gib FROM uploads',
    "SELECT value AS app, uploads FROM tag_counts('App-Name') ORDER BY uploads DESC LIMIT 5",
    'SELECT kind, count(*) AS records FROM entities GROUP BY kind ORDER BY records DESC',
  ];
}
for (const q of sql ? [sql] : questions) {
  console.log(`\n${q}`);
  const rows = (await c.runAndReadAll(q)).getRowObjectsJson();
  console.table(rows);
}
c.closeSync();
