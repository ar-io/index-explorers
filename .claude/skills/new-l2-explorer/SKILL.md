---
name: new-l2-explorer
description: Build a verifiable explorer for a new parquet-l2 index (another app's data items, selected by a tag) on @ar-io/index-client, from the selection to a page with fixtures and E2E. Use when asked to "index <app> like ArDrive", "make an explorer for <app>'s data items", or to add a selection layer to the client.
---

# A new L2 index and its explorer

ArDrive is one selection; the layout, client and chassis are generic. Read
`docs/new-l2-index.md` first: it is the recipe this skill walks through, and
it cites the gateway-side documentation in ar-io/ar-io-node.

## Steps

1. **Confirm the index exists or define it.** Fetch the publisher's
   `/ar-io/indexes` and look for an index of `kind: parquet-l2` whose
   `filter`/`metadata.selection` is the app's tag. If none, the operator
   publishes one: `INDEX_EXPORT_KINDS` and `INDEX_EXPORT_L2_INDEXES` in
   ar-io-node (`docs/index-export.md` § "L2 bands"). Do not invent bands.
2. **Learn the app's tags.** Query the selection's `tags` over a small window
   with the client (or DuckDB over one band's `tags.parquet`): which tags
   identify an object, a group, a version, a time. Write them down with
   counts (`tag_counts('<Tag>')` from the lookups is exact and cheap).
3. **Write the layer.** Copy `packages/index-client/src/layouts/arfs.ts` to
   `layouts/<app>.ts`. Change the tag list, the pivot columns, the
   latest-version rule and the group lookup (`drive_window` → your group
   tag). Keep every reader bounded by height. Export it from `src/index.ts`.
4. **Test the layer in native DuckDB** over a recorded band
   (`packages/index-client/test/layouts.test.ts` is the model): the pivot
   agrees with scans; the lookup macro agrees with the tables.
5. **Fixtures.** Add a generator for the selection's items beside
   `scripts/build-fixtures.ts` (the band files, lookups, torrents and the
   signed publication are generic there); point `tools/fixture-gateway` at
   the output.
6. **The page.** Copy `apps/network-index` (smallest) or
   `apps/ardrive-explorer` (full). Replace the selection-specific model and
   views; keep the session, publication reading, engine, receipts, periods,
   exports and share links. Set `CONFIG.indexName`. Keep the DOM ids the E2E
   helpers use.
7. **E2E.** Port `e2e/tests/smoke.spec.ts` first, then what the page offers.
   Measure the listing path with `perf.spec.ts`'s method (in-page timings,
   long tasks, heap) and put the numbers in the PR.
8. **Docs and deploy.** A README for the app, a line in the root README's
   table, the tag prefix in `.github/workflows/deploy.yml`, the ArNS name.

## Non-negotiables

- Never weaken a check. Names from record JSON are labelled as not covered
  by the signature and size-checked against the index.
- Layout knowledge lives in the client's `layouts/`, not in the app.
- Gaps in the index (no key-tag lookup, no stats band) are asked for
  upstream in ar-io/ar-io-node, not papered over.
