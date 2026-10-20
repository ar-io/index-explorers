# @ar-io/index-client

The verifiable index client: everything a page (or a script) needs to read an
ar.io gateway's signed index publication without trusting the server that
served it. Pure TypeScript, no DOM except the service worker, unit-tested
against recorded fixtures.

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
| `gateway.ts` | `pickGateway`, `autoCandidates`, `mirrorsOf`, `fetchBandDates`, `KNOWN_PUBLISHERS`, `REGISTRY_GATEWAYS` |
| `range/torrent.ts` | `checkTorrent`, `pieceOk`, `bdecode`/`bencode`, `buildTorrent` (fixtures), `Refusal` |
| `range/sw.ts` | the service worker (built to `sw.js` by the Vite plugin in `vite.ts`) |
| `range/reader.ts` | `registerRangeReader`, `rangeSpec`, `rangeable`, receipts (`Watch`, `receiptText`), `explainReadError` |
| `engine/engine.ts` | `openEngine`/`Engine` (one serialised connection, `registerUrl`, `resetConnection`), `rowsOf`, `columnsOf`, `timeColumnsOf` |
| `layouts/parquet-l2.ts` | the ArFS pivot and views for `parquet-l2` bands: `l2BaseSql`, `l2PeriodViewsSql`, `entitiesSql`, `uploadsSql`, `newestDrivesSql`, `clusterSql`, `tagCountsSql` |
| `layouts/parquet-l1.ts` | `l1PeriodSql` (`blocks`, `rawtx`, `txs`, `tags`), `l1LookupSql` (`find_tx`, `wallet_totals`, `tag_counts`), `txLookupSql` |
| `layouts/cdb64.ts` | `lookupRoot`, `cdb64Get`, `cdb64Hash`, `parseCdb64Manifest`, `decodeRootValue` |
| `cost.ts` | `windowCost`, `buildPeriods`, `heightAt`/`timeAt`, `clusterHeights`, `sliceWindow` |
| `util/` | bytes/base64url/base58/SHA-256, fetch with timeouts and progress, formatting |

## Using it

In a browser page (see `apps/ardrive-explorer/src/session.ts` for the whole flow):

```ts
import {
  fetchPublication, verifyPublication, selectIndex, registerRangeReader,
  rangeSpec, openEngine, parquetL2, REGISTRY_GATEWAYS,
} from '@ar-io/index-client';
import lock from '../engine.lock.json';

const reader = await registerRangeReader(); // ./sw.js, built by rangeReaderPlugin()
const pub = await fetchPublication('https://turbo-gateway.com');
const proof = await verifyPublication(pub.doc, { registryGateways: REGISTRY_GATEWAYS, excluding: pub.gateway });
const { bands } = selectIndex(pub.doc, 'ardrive-l2', { gateway: pub.gateway });

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
const table = await engine.query(`SELECT * FROM drive_window('05b211dd-ae1e-44ef-b055-2e102933e4e8')`);
```

In Node, without the worker or the engine (verification, torrents and the
CDB64 lookup are plain functions): see `examples/lookup-root.ts` at the repo
root, which verifies a publication, fetches and checks a band's torrent, and
resolves a data item to its root transaction with range reads checked piece
by piece.

In Vite, `rangeReaderPlugin()` from `@ar-io/index-client/vite` builds the
worker as `sw.js` beside the page and serves it in dev.

## Rules the code keeps

- Never weaken a check to make something work. A gateway that sends bytes
  that do not match is refused with the reason, and the next source is tried;
  the answer is never assembled from unchecked bytes.
- Names (record JSON) are not this package's business: they are not covered
  by the signature. Apps fetch them and say so.
- Lessons from v0 (V1-ARCHITECTURE.md §8): convert Arrow rows at the
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
