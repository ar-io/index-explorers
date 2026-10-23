// The newest-drives list, live, from a cold browser: time and bytes to the
// first page, then each "Show older drives", with the page's own receipt.
// Serve the production build first (or point LIVE_BASE at a deployed page):
//   node tools/fixture-gateway/server.mjs --site apps/ardrive-explorer/dist --port 8797
//   node e2e/debug-drive-list.mjs [pages] [period]
import { chromium } from '@playwright/test';

const PAGES = Number(process.argv[2] || 4);
const PERIOD = process.argv[3] || '';
const BASE = process.env.LIVE_BASE || 'http://localhost:8797/';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const until = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
const status = () =>
  page
    .locator('#status')
    .innerText()
    .catch(() => '');
const rows = () => page.locator('#results tbody tr').count();
const settled = () => until(async () => /Read|Nothing new|Answered/.test(await status()), 300000);
let t0 = Date.now();
await page.goto(BASE);
await until(async () => (await rows()) > 0, 300000);
await settled();
console.log(
  `first page ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await rows()} rows | ${await status()}`,
);
if (PERIOD) {
  await page.evaluate(() => window.__explorer.store.say(''));
  t0 = Date.now();
  await page.selectOption('#scope', PERIOD);
  await settled();
  console.log(
    `${PERIOD}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await rows()} rows | ${await status()}`,
  );
}
for (let i = 1; i < PAGES; i++) {
  const older = page.locator('#more button', { hasText: 'Show older' });
  if (!(await older.count())) break;
  await page.evaluate(() => window.__explorer.store.say(''));
  t0 = Date.now();
  await older.click();
  await settled();
  console.log(
    `page ${i + 1}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await rows()} rows | ${await status()}`,
  );
}
const cells = await page.locator('#results tbody td.num').allInnerTexts();
console.log(
  'records:',
  cells.slice(0, 20).join(' '),
  '|',
  await page
    .locator('#more')
    .innerText()
    .catch(() => ''),
);
await browser.close();
