/**
 * Two projects. `fixtures` runs against the local fixture gateway (the
 * synthetic publication, deterministic, no network) with the E2E build of
 * each app (dist-e2e, pointed at the local gateway). `live` runs the same
 * suites against turbo-gateway.com with the production build, nightly.
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = !!process.env.LIVE;
// The live project serves the production builds on a port of its own, and never
// reuses a server it did not start: a fixture gateway left running on 8787
// serves the E2E builds, which read the local fixture registry, and every live
// check then fails with "publisher is not in the registry".
const PORT = Number(process.env.FIXTURE_PORT || (LIVE ? 8797 : 8787));

export default defineConfig({
  testDir: path.join(ROOT, 'e2e', 'tests'),
  outputDir: path.join(ROOT, 'e2e', 'out'),
  timeout: LIVE ? 600_000 : 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: LIVE ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: path.join(ROOT, 'e2e', 'report'), open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    acceptDownloads: true,
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
  projects: [
    {
      name: 'fixtures',
      use: { baseURL: `http://localhost:${PORT}/` },
      testIgnore: /live\./,
    },
    {
      name: 'live',
      use: { baseURL: process.env.LIVE_BASE || `http://localhost:${PORT}/` },
      testIgnore: /\.fixture\./,
    },
  ],
  webServer: {
    command: LIVE
      ? `node tools/fixture-gateway/server.mjs --site apps/ardrive-explorer/dist --mount /l1/=apps/arweave-l1-explorer/dist --mount /network-index/=apps/network-index/dist --port ${PORT}`
      : `node tools/fixture-gateway/server.mjs --site apps/ardrive-explorer/dist-e2e --mount /l1/=apps/arweave-l1-explorer/dist-e2e --mount /network-index/=apps/network-index/dist-e2e --port ${PORT}`,
    cwd: ROOT,
    port: PORT,
    reuseExistingServer: !LIVE && !process.env.CI,
    timeout: 30_000,
  },
});
