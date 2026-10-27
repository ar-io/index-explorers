# @ar-io/index-client

The verifiable index client: everything a page (or a script) needs to read an
ar.io gateway's signed index publication without trusting the server that
served it. Pure TypeScript, no DOM except the service worker, unit-tested
against recorded fixtures.

It is not published to npm, and a package of this name there is not ours. The
pages here are examples: use the client from this repository, in a fork or by
copying `packages/index-client` into your own project.

What it checks, in order:

1. **The publication.** `/ar-io/indexes` is parsed and validated against the
   version-1 shape and bounds, the publisher's signing key is read from the
   ar.io registry through a *different* gateway, and the Ed25519 signature is
   verified over `ar-io-index-publication/v1\n` + RFC 8785 canonical JSON
   (unknown fields included). A check that cannot run is a failure.
2. **Every byte of index.** Band files are read in byte ranges through
   `sw.ts`, a service worker that answers only with bytes it has checked
   against the file's BitTorrent v2 hash tree; the tree is trusted only
   through the infohash the signed publication pins. Nothing unverified
   reaches the engine.
3. **The engine.** DuckDB-WASM and its worker are pinned by SHA-256
   (`engine.lock.json` at the repo root); the Parquet extension by DuckDB's
   own signature.

The formats are documented in ar-io/ar-io-node under `docs/`
(`index-publication.md`, `cdb64-format.md`, `index-swarm.md`).

## Modules

| module | exports |
| --- | --- |
| `publication.ts` | `fetchPublication`, `parsePublication`, `lookupRegistry`, `verifyPublication`, `verifySignature`, `signingBase`, `selectIndex`, `tipOf`, the `Publication`/`Band` types |
| `gateway.ts` | `pickGateway` (a `NoGatewayError` says per host why none offered the index), `autoCandidates`, `mirrorsOf`, `fetchBandDates`, `KNOWN_PUBLISHERS`, `REGISTRY_GATEWAYS` |
| `range/torrent.ts` | `checkTorrent`, `pieceOk`, `bdecode`/`bencode`, `buildTorrent` (fixtures), `Refusal` |
| `range/sw.ts` | the service worker (built to `sw.js` by the Vite plugin in `vite.ts`) |
| `range/reader.ts` | `registerRangeReader`, `rangeSpec`, `rangeable`, receipts (`Watch`, `receiptText`; failovers grouped per source and kind, `notesText`), `explainReadError` |
| `range/protocol.ts` | the page–worker protocol: `RangeSpec`, `encodeSpec`/`decodeSpec`, `RangeTotals` |
| `engine/read-ahead.ts` | `planReads`, `readAhead`, `readAheadSql`, `engineReads`: work out from the files' footers exactly what a query will fetch, and fetch it in parallel before DuckDB asks for it one range at a time |
| `engine/engine.ts` | `openEngine`/`Engine` (one serialised connection, `registerUrl`, `resetConnection`), `rowsOf`, `columnsOf`, `timeColumnsOf` |
| `layouts/parquet-l2.ts` | the generic `parquet-l2` layout, any selection: `parseL2Selection`, `l2SelectionOf`, `findL2Index` (the index that selects exactly what a page reads, whatever its name), `l2BaseSql` (items, tags, lookups, `uploads_between`, `find_id`, `wallet_totals`, `tag_counts`), `l2PeriodViewsSql` (`uploads`, `tags`), `itemsSql`, `tagsSql`, `uploadsSql`, `tagCountsSql`, `walletHeightsSql`; layout `l2-2`'s key lookup and stats (`keyTagsOf`, `keyHeightsSql`, `tagWindowSql`, `statTagsOf`, `statCountsSql`); and what each reads, for `readAhead` (`windowReadAhead`, `clustersReadAhead`, `tagLookupReadAhead`, `walletLookupReadAhead`, `keyLookupReadAhead`) |
| `layouts/arfs.ts` | ArDrive's layer over it, the worked example of a selection layer: `ARDRIVE_SELECTION`, `entitiesSql`, `arfsBaseSql` (`entities_between`, `drive_window`, `drive`), `arfsPeriodViewsSql` (`entities`, `drives`, `folders`, `files`), `newestDrivesSql`, `clusterSql` |
| `layouts/parquet-l1.ts` | `l1PeriodSql` (`blocks`, `rawtx`, `txs`, `tags`), `l1LookupSql` (`find_tx`, `wallet_totals`, `tag_counts`), `txLookupSql` |
| `layouts/cdb64.ts` | `lookupRoot`, `cdb64Get`, `cdb64Hash`, `parseCdb64Manifest`, `decodeRootValue` |
| `layouts/keys.ts` | `KEY_MACROS` (`b64u`, `unb64u`, `key64`, `hkey`: the key functions the lookup files are sorted by), `idKeySql`, `tagKeySql`, `readList` |
| `msgpack.ts` | `decodeMsgpack`/`encodeMsgpack`: the subset the root-tx index's values use |
| `cost.ts` | `buildPeriods`, `heightAt`/`timeAt`, `clusterHeights`, `sliceWindow` |
| `util/` | bytes/base64url/base58/SHA-256, fetch with timeouts and progress, formatting |

## Using it

Every use is the same four steps; only the last changes with the index.

1. **Verify the publication.** `fetchPublication(gateway)`, then
   `verifyPublication(doc, { registryGateways: REGISTRY_GATEWAYS, excluding: gateway })`.
   It throws unless the signature verifies under the key the registry gives
   for the publisher, read through another gateway.
2. **Pick the index.** `selectIndex(doc, name, { gateway })` gives its bands
   (superseded, empty and overlapped bands left out, with why, in `dropped`).
   For a `parquet-l2` index, find the name by what it selects:
   `parquetL2.findL2Index(doc, selection, preferredName)` returns the index
   that selects exactly `selection`, or `{ name: null, why }`.
3. **Read only checked bytes.** Either a whole file, checked against the
   SHA-256 the signed publication lists for it (`band.files.get(name).sha256`),
   or byte ranges, each piece checked against the band's BitTorrent v2 tree
   (`checkTorrent` on the band's `.torrent`, then `pieceOk` per piece). In a
   page the service worker does the second for you.
4. **Ask.** CDB64: `cdb64.lookupRoot(id, { bands, read })`. Parquet: register
   the band files with DuckDB under any names, run the layout's SQL
   (`parquetL1.l1PeriodSql`, `parquetL2.l2BaseSql` and `l2PeriodViewsSql`, a
   selection layer such as `arfs.arfsBaseSql`), then query its views and
   macros.

| to | in Node | in a page |
| --- | --- | --- |
| verify a publication | `examples/lookup-root.ts` | `apps/network-index/src/session.ts` |
| look up a data item's root transaction (CDB64) | `pnpm example:lookup <id>` | `apps/network-index` |
| SQL over `parquet-l1` | `pnpm example:query l1` | `apps/arweave-l1-explorer/src/session.ts` |
| SQL over a `parquet-l2` selection | `pnpm example:query ardrive` | `apps/ardrive-explorer/src/session.ts` |

The examples are in [`examples/`](../../examples/README.md) at the repo root.
In Node they use native DuckDB (`@duckdb/node-api`) over files checked
whole; the layout SQL is the same text the pages run in DuckDB-WASM.

In a browser page (see `apps/ardrive-explorer/src/session.ts` for the whole flow):

```ts
import {
  fetchPublication, verifyPublication, selectIndex, registerRangeReader,
  rangeSpec, openEngine, parquetL2, arfs, REGISTRY_GATEWAYS,
} from '@ar-io/index-client';
import lock from '../engine.lock.json';

const reader = await registerRangeReader(); // ./sw.js, built by rangeReaderPlugin()
const pub = await fetchPublication('https://turbo-gateway.com');
const proof = await verifyPublication(pub.doc, { registryGateways: REGISTRY_GATEWAYS, excluding: pub.gateway });
const found = parquetL2.findL2Index(pub.doc, arfs.ARDRIVE_SELECTION, 'ardrive-l2');
if (found.name === null) throw new Error(found.why);
const { bands } = selectIndex(pub.doc, found.name, { gateway: pub.gateway });

const engine = await openEngine({ hosts: lock.hosts, pins: lock });
const registered = [];
for (const band of bands) {
  const names = {};
  for (const kind of ['it', 'tg', 'li', 'lw', 'lg'] as const) {
    const file = band.files.get(parquetL2.L2_FILES[kind])!;
    const name = engine.freshName(kind);
    await engine.registerUrl(name, reader.url(rangeSpec(band, file)));
    names[kind] = name;
  }
  registered.push({ id: band.id, from: band.from, to: band.to!, names });
}
await engine.exec(parquetL2.l2BaseSql(registered));
await engine.exec(arfs.arfsBaseSql(registered));
const table = await engine.query(`SELECT * FROM drive_window('05b211dd-ae1e-44ef-b055-2e102933e4e8')`);
```

A page registers only the bands a question's heights touch: a view over
every band reads every file's footer on the first query. The apps build
views per window (`l2PeriodViewsSql(bands, lo, hi)`, `l1PeriodSql`) and use
`planReads` to say what a listing will fetch before fetching it: it reads
the files' footers (which the listing needs anyway) and sums the column
chunks the query reads, as the engine reads them. A lookup is read ahead the
same way: the row groups a key's statistics can hold, in every band at once,
or, for an address over a window, only the window's bands.

In Vite, `rangeReaderPlugin()` from `@ar-io/index-client/vite` builds the
worker as `sw.js` beside the page and serves it in dev.

### What each layout gives you to query

| layout | views | macros |
| --- | --- | --- |
| `parquet-l1` (`l1PeriodSql`) | `blocks`, `txs`, `rawtx`, `tags` | `find_tx(id)`, `wallet_totals(address)`, `tag_counts(name)` |
| `parquet-l2` (`l2BaseSql`, `l2PeriodViewsSql`) | `uploads`, `tags`, `items_all`, `tags_all` | `find_id(id)`, `wallet_totals(address)`, `tag_counts(name)`, `uploads_between(lo, hi)` |
| ArDrive's layer (`arfsBaseSql`, `arfsPeriodViewsSql`) | `entities`, `drives`, `folders`, `files` | `entities_between(lo, hi)`, `drive_window(driveId)`, `drive(driveId)` |

The macros read the band's lookup files when every band in the period has
them (a few kilobytes per answer), and scan the tables otherwise.

## Rules the code keeps

- Never weaken a check to make something work. A gateway that sends bytes
  that do not match is refused with the reason, and the next source is tried;
  the answer is never assembled from unchecked bytes.
- Names (record JSON) are not this package's business: they are not covered
  by the signature. Apps fetch them and say so.
- The lessons in the repo's `CONTRIBUTING.md`: convert Arrow rows at the
  boundary; build views per height window; dedupe `data_items` with
  `GROUP BY`; a per-window cost minimum; reset the connection after OOM;
  resume the worker after Stop; drop `records: 0` bands; bound `Unix-Time`
  in SQL.

## Tests

`pnpm test` here runs Vitest: the publication against the recorded
turbo-gateway.com document and tampered copies; the hash tree against a real
torrent and a flipped byte; CDB64 against a written partition; the cost model
against recorded sizes; and the L2 SQL over a recorded band in native DuckDB
(`@duckdb/node-api`). Fixtures live in `../../fixtures/live`.
