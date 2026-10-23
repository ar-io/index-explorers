// Time to first rows of the big drive, live, from a cold browser each run,
// with the page's trace. Serve the production build first:
//   node tools/fixture-gateway/server.mjs --site apps/ardrive-explorer/dist --port 8797
//   node e2e/debug-first-rows.mjs [runs]
import { chromium } from '@playwright/test';

const RUNS = Number(process.argv[2] || 3);
const BASE = process.env.LIVE_BASE || 'http://localhost:8797/';
const DRIVE = 'b76a5542-40c4-415c-8796-365d8dc365c7';
const browser = await chromium.launch();
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await until(async () => (await page.locator('#results tbody tr').count()) > 0, 240000);
  const t0 = Date.now();
  await page.fill('#find', DRIVE);
  await page.click('#findgo');
  await until(
    async () =>
      (await page.locator('#cost button').count()) > 0 ||
      (await page.locator('#b-list tbody tr.b-row').count()) > 0,
    120000,
  );
  if (await page.locator('#cost button').count()) await page.locator('#cost button').click();
  await until(async () => (await page.locator('#b-list tbody tr.b-row').count()) > 0, 120000);
  const s = (Date.now() - t0) / 1000;
  const trace = await page.evaluate(() => window.__explorer.store.trace.slice(-16));
  const start = Number(trace.find((t) => / (lookup ahead|ensureBands)/.test(t))?.split(' ')[0]);
  console.log(
    `run ${i + 1}: first rows ${s.toFixed(1)} s | ${await page.locator('#status').innerText()}`,
  );
  console.log(
    '  ' +
      trace
        .map((t) => `${Number(t.split(' ')[0]) - start} ${t.split(' ').slice(1).join(' ')}`)
        .join(' | '),
  );
  await ctx.close();
}
await browser.close();
