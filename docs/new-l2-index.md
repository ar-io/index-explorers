# Publishing and exploring a new L2 index

`ardrive-l2` is one **selection**: the ANS-104 data items whose `App-Name` tag
starts with `ArDrive`. The `parquet-l2` layout, the publication protocol, the
client and the page chassis are generic; ArDrive is the worked example. This
recipe goes from a selection to a published, verifiable index and a page that
browses it. It cites the authoritative documentation where it lives
(ar-io/ar-io-node for the gateway side) rather than repeating it.

## 1. Define the selection

A selection is one tag name, a value prefix, and optionally a longer prefix to
exclude. An item is in it when one of its tags is named `name` exactly and its
value starts with `valuePrefix` and not with `excludeValuePrefix`, compared as
UTF-8 bytes. The selection is bound into every band's id, so it never changes:
a new selection is a new index under a new name.

```json
{ "kind": "ans104-data-items", "tag": { "name": "App-Name", "valuePrefix": "MyApp" } }
```

Pick a name matching `[a-z0-9-]{1,64}`, by convention `<app>-l2`.

Reference: ar-io-node `docs/index-publication.md` § "L2 bands" (the format,
`band.json`, the lookup files) and `src/lib/parquet-l2/layout.ts`
(`parseSelection`).

## 2. Build and publish the bands (a gateway operator)

On a gateway that unbundles and runs ClickHouse, the `index-export` service
builds L2 bands from the gateway's own index, once a day, on the same height
grid as L1 bands, and `index-swarm` publishes them.

```bash
# .env
INDEX_EXPORT_KINDS=root-tx-index,parquet-l1,parquet-l2
INDEX_EXPORT_L2_INDEXES='[{"name":"myapp-l2","selection":{"kind":"ans104-data-items","tag":{"name":"App-Name","valuePrefix":"MyApp"}}}]'
INDEX_SWARM_PUBLISH='[{"name":"root-tx-index","kind":"cdb64-root-tx"},{"name":"myapp-l2","kind":"parquet-l2"}]'
INDEX_EXPORT_HEADER_CHECK_URL=https://turbo-gateway.com   # or http://core:4000 on an indexer that holds the roots
```

Dry-run one band first, then start the service:

```bash
docker compose --profile index-export run --rm -T index-export --once --dry-run --range 1300000-1399999 > myapp-l2.json
docker compose --profile index-export up -d index-export
./tools/index-swarm-status
```

Reference: ar-io-node `docs/index-export.md` § "L2 bands", "Where L2 rows
come from", "Checks before publishing", "Lifecycle" and "Running L2 exports";
`docs/envs.md` for every `INDEX_EXPORT_L2_*` setting; `docs/index-swarm.md`
§ "Publish this gateway's index". The bands appear in the gateway's
`/ar-io/indexes` under the new name, each with its files' sizes and SHA-256s
and a torrent.

## 3. Verify what was published (anyone)

```bash
./tools/ar-io-node index-l2-verify --bands-dir data/indexes/installed/myapp-l2 --publisher <publisher wallet>
```

checks every band's id against its contents, every table row by row, the
lookups, and a sample of locations against the chain. Reference: ar-io-node
`docs/index-verification.md` and `docs/cli.md` § `index-l2-verify`. Without a
gateway, the client's Node example verifies the publication and reads any
band in checked ranges: `pnpm example:lookup <id>` here, or adapt
`examples/lookup-root.ts`.

A subscriber takes the index by naming it:
`INDEX_SWARM_SUBSCRIBE='[{"publisher":"<wallet>","name":["root-tx-index","myapp-l2"]}]'`.

## 4. Read it with the client

Everything generic works unchanged: `selectIndex(pub.doc, 'myapp-l2', …)`,
`parquetL2.l2BaseSql` (items, tags, lookups, `uploads_between`, `find_id`,
`wallet_totals`, `tag_counts`), `parquetL2.l2PeriodViewsSql` (`uploads`,
`tags`), the cost model and the range reader. A page that only needs
uploads, owners, sizes, content types and tag counts needs nothing more: the
L1 explorer and the network index are built that way.

## 5. Write the selection's layer

What the items *mean* is the app's. ArDrive's layer is
`packages/index-client/src/layouts/arfs.ts`: a pivot of the tags it cares
about (`ENTITY_TAGS`) into one row per record, bounded by height
(`entitiesSql(bands, lo, hi)`), the base macros its lookups need
(`arfsBaseSql`: `entities_between`, and `drive_window`/`drive` over the tag
lookup), and the period views a SQL cell documents (`arfsPeriodViewsSql`:
`entities`, `drives`, `folders`, `files` with the latest-version rule).

Copy it to `layouts/<app>.ts` and change three things:

1. the tag list and the `max(CASE WHEN name = … THEN value END)` columns of
   the pivot, to your tags;
2. the "latest wins" rule, if your app writes several items per logical
   object (ArFS uses `height DESC, Unix-Time DESC` per `File-Id`);
3. the lookup macro: `drive_window(d)` reads the tag lookup for a
   `Drive-Id` value, which gives the count and the first and last height of
   any tag value before anything of the tables is read. Any tag that
   identifies a group of your items (a collection id, a process id) works the
   same way: `hkey('<Tag-Name>')` and `hkey(value)`.

Keep the rules the layout keeps: every reader bounded by height, no window
function over an unbounded table, `GROUP BY id, height` to dedupe
`data_items`, and `CREATED_AT` (or your own bound) around any timestamp tag.
Add a test like `packages/index-client/test/layouts.test.ts`: it runs the
SQL in native DuckDB over a recorded band and checks the pivot against scans
and the lookups against the tables.

## 6. Build the page

Start from `apps/network-index` (the smallest page on the client) or
`apps/ardrive-explorer` (the full product: one store, one session, flows,
pure models, Preact views). In the ArDrive app the selection-specific parts
are `src/model/arfs.ts` (records → tree), `src/data/drives.ts` and the
drive browser views; the session, the publication reading, the engine, the
receipts, the periods, the questions machinery, exports and share links are
generic and read `CONFIG.indexName`.

Names: if your records carry a human name inside their JSON, fetch it as
ArDrive's page does (`src/model/names.ts`), label it as not covered by the
signature, and size-check it against the index's `data_size`.

## 7. Fixtures and tests

`scripts/build-fixtures.ts` generates a signed publication over synthetic
bands; the generator's `arfsTags` and `makeDrive` write ArDrive's tags. Write
the equivalent for your selection (the items, tags and record JSON; the band
files, lookups, torrent and signature are generic), point the fixture gateway
at it, and port the E2E suites: the publication verifies, the range reader
controls the page, a listing answers with a receipt, and the acceptance
numbers hold.

## 8. Ship it

Add the app under `apps/`, its tag prefix to the Deploy workflow, and the
ArNS name. Deploys run only from a tag after the live E2E passes.

## What to ask upstream rather than work around

The gaps the ArDrive page lives with are tracked in ar-io/ar-io-node and
apply to any selection: a key-tag lookup per band (so a group of items costs
one row group per band instead of a window scan), a per-band `stats.parquet`
(so "over all history" questions need no scan), and band dates in
`band.json`. Use the lookups where a band lists them; fall back to windows
otherwise; do not paper over a gap in the app.
