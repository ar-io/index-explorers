# CLAUDE.md

Guidance for Claude Code and other agents working in this repository.

## What this is

A pnpm monorepo. `packages/index-client` is the verifiable index client (the
piece the organisation keeps); `packages/ui` holds tokens and primitives;
`apps/ardrive-explorer`, `apps/arweave-l1-explorer` and `apps/network-index`
are the three pages, built with Preact + TypeScript + Vite and served from
Arweave manifests. The design brief is V1-ARCHITECTURE.md in
ar-io/permaweb-services (`turbo-gateway/publish/ardrive-explorer/`); the index
formats are in ar-io/ar-io-node under `docs/`.

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
- Performance: the acceptance table in V1-ARCHITECTURE.md §4.2 (20,000-record
  drive: longest main-thread task ≤ 130 ms, any sort ≤ 160 ms, 200 rows then
  more on scroll; folder moves ≤ 400 ms). `e2e/tests/perf.spec.ts` measures
  it; run it before and after touching the drive-browser path.
- Layout knowledge lives in the client's `layouts/`, not in an app. Apps keep
  one store, one session, pure models, no module-scope state, no string DOM.
- Deploys only from a tag through the Deploy workflow (ario-deploy), and only
  as the bytes `node scripts/release.mjs verify <app> --version <x.y.z>`
  verified on a clean checkout and recorded in `releases/<app>.json`. Never
  upload from a machine; never edit a release record by hand.
- Never run the suites on a gateway server.

## Lessons already paid for

Read V1-ARCHITECTURE.md §8 before touching the client or the drive browser.
Added in v1: a one-letter search must not match uuids; Arrow timestamps come
back in the engine's unit (microseconds) when read column-wise, use `get()`;
decode Arrow columns per chunk with `slice()` or every chunk re-decodes the
whole column; E2E tests clear the status line through the store
(`window.__explorer.store.say('')`), never by writing the DOM; a Playwright
`innerText()` on an element that may be absent waits for the whole timeout,
check `count()` first; keep logs you want outside `e2e/out/`, Playwright
cleans it.

## Repository conventions

Conventional commits. PRs are small and carry measured numbers. On this
machine a workspace guard blocks force-pushes and pushes from `main`: work on
a topic branch and let the human merge.
