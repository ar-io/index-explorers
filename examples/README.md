# Examples

Standalone uses of `@ar-io/index-client`, runnable from a checkout after
`pnpm install`. Each verifies the gateway's signed publication first and uses
only bytes it has checked. They read turbo-gateway.com unless told otherwise.

| example | what it shows | checks |
| --- | --- | --- |
| `lookup-root.ts` | the CDB64 root-tx index: which Arweave transaction holds a data item | publication signature; each range read against the band's BitTorrent v2 tree, piece by piece |
| `query-band.ts` | SQL over one band of `parquet-l1`, or of the `parquet-l2` index that selects ArDrive's data items | publication signature; each file whole against the SHA-256 the publication signs |

## Look up a data item's root transaction

```bash
pnpm example:lookup 4aCplvNxtUx2DnpUUhhGkecFXiUDJFYhZDlra8ClGXA [gateway]
```

```text
publication #207 by 34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5: verified against the registry read through https://vilenarios.com
18 root-tx bands
{
  "band": "h-h1300000-1399999-3078e8b8-532b4bf92985",
  "partition": "e1.cdb",
  "rootTxId": "rsT-ic8mRrxu-bnTYiT3jzh-blkRPEhzlDw_uljO7kA",
  ...
  "reads": 5,
  "bytesFetched": 6307640,
  "piecesChecked": 35
}
```

Its range reader is twenty lines of `fetch` with a `Range` header, each piece
checked with the client's `pieceOk` before use. Copy it when you need a few
kilobytes of a large file.

## SQL over a band

```bash
pnpm example:query l1                       # parquet-l1, the newest band, three example questions
pnpm example:query ardrive                  # the L2 index that selects ArDrive's data items
pnpm example:query ardrive "SELECT drive_id, privacy, created_at FROM drives LIMIT 3" \
  --band l2-h700000-799999-3078e8b8-a2a34f51df49
```

```text
publication #207 by 34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5: verified against the registry read through https://vilenarios.com
ardrive-l2 selects App-Name starting "ArDrive", not "ArDriver", as asked
band l2-h2025000-2027654-3078e8b8-b767b1bd3ec8: blocks 2,025,000 to 2,027,654, 69,607 records
  data_items.parquet: 4.0 MB, SHA-256 matches the publication
  ...
SELECT value AS app, uploads FROM tag_counts('App-Name') ORDER BY uploads DESC LIMIT 5
│ 0 │ 'ArDrive-App'  │ '42239' │
│ 1 │ 'ArDrive-CLI'  │ '27206' │
...
```

The L2 index is found by what it selects (`parquetL2.findL2Index` with
`arfs.ARDRIVE_SELECTION`), not by its name: a name proves nothing about what
a band holds. For another app's index, pass its selection instead.

It downloads the band's files whole (the newest bands are under 10 MB) and
runs the client's layout SQL in native DuckDB (`@duckdb/node-api`). The
views and macros you can query are listed in the client's README under
"What each layout gives you to query". Older bands span 100,000 blocks and
run to 1.5 GB (one `ardrive-l2` band is 9.3 GB): for those, read ranges as
`lookup-root.ts` does, or as the pages do through the service worker.

## In a browser

The apps are the browser examples: `apps/network-index` (the smallest:
verification and the CDB64 lookup), `apps/arweave-l1-explorer` (SQL over
`parquet-l1` in DuckDB-WASM) and `apps/ardrive-explorer` (an L2 selection
with its own layer). Each keeps the whole flow in `src/session.ts`.
