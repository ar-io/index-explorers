# CLAUDE.md

Guidance for Claude Code and other agents working in this repository.

## What this is

A pnpm monorepo. `packages/index-client` is the verifiable index client (the
piece the organisation keeps); `packages/ui` holds tokens and primitives;
`apps/ardrive-explorer`, `apps/arweave-l1-explorer` and `apps/network-index`
are the three pages, built with Preact + TypeScript + Vite and served from
Arweave manifests. The index formats are in ar-io/ar-io-node under `docs/`.

## Commands

```bash
pnpm install && node scripts/fetch-engine.mjs
pnpm lint                                   # prettier --check + typecheck everywhere
pnpm test                                   # Vitest (index-client runs native DuckDB)
pnpm --filter "./apps/*" run build:e2e      # apps pointed at the local fixture gateway
pnpm e2e                                    # Playwright on fixtures (no network)
pnpm e2e:live                               # the same against turbo-gateway.com
pnpm fixtures:build                         # regenerate fixtures/synthetic (then commit it)
pnpm pins:check                             # engine.lock.json vs npm and two gateways
pnpm --filter ./apps/ardrive-explorer run dev
```

One package's tests: `pnpm --filter ./packages/index-client test`. One E2E
spec: `npx playwright test -c e2e/playwright.config.ts --project=fixtures nav`.

## Non-negotiables

- Trust: everything from the index is verified before use. Never weaken a
  check to make a test pass. Names (record JSON) are not covered by the
  signature: label them so and size-check them against the index.
- Performance: the budget in CONTRIBUTING.md (20,000-record drive: longest
  main-thread task ≤ 130 ms, any sort ≤ 160 ms, 200 rows then more on
  scroll; folder moves ≤ 400 ms). `e2e/tests/perf.spec.ts` measures
  it; run it before and after touching the drive-browser path.
- Layout knowledge lives in the client's `layouts/`, not in an app. Apps keep
  one store, one session, pure models, no module-scope state, no string DOM.
- `parquet-l2` is generic; ArDrive is one selection. What is ArFS lives in
  `layouts/arfs.ts` and the ArDrive app, never in `layouts/parquet-l2.ts`.
  A new selection gets its own layer: `docs/new-l2-index.md`, skill
  `new-l2-explorer`.
- Deploys only from a tag through the Deploy workflow (ario-deploy), and only
  as the bytes `node scripts/release.mjs verify <app> --version <x.y.z>`
  verified on a clean checkout and recorded in `releases/<app>.json`. Never
  upload from a machine; never edit a release record by hand.
- Never run the suites on a gateway server.

## Lessons already paid for

Read "Lessons the code keeps" in CONTRIBUTING.md before touching the client
or the drive browser. Keep logs you want outside `e2e/out/`: Playwright
cleans it.

## Repository conventions

Conventional commits. PRs are small and carry measured numbers. Work on a
topic branch; a maintainer reviews and merges. Never force-push a shared
branch.
