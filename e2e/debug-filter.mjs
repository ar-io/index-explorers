import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
const PORT = 8787;
const gw = spawn(
  'node',
  [
    'tools/fixture-gateway/server.mjs',
    '--site',
    'apps/ardrive-explorer/dist-e2e',
    '--port',
    String(PORT),
  ],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 500)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300));
});
const until = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
const dump = async (label) =>
  console.log(
    `--- ${label}`,
    JSON.stringify(
      await page.evaluate(() => {
        const s = window.__explorer.store;
        return {
          status: s.status.value.text,
          sub: s.content.value.sub,
          rows: s.content.value.table?.rows.length,
          view: s.view.value,
          privacy: s.privacy.value,
          progress: s.progress.value.note,
          trace: s.trace.slice(-10),
        };
      }),
      null,
      1,
    ),
  );
await page.goto(
  `http://localhost:${PORT}/#gw=${encodeURIComponent('http://localhost:' + PORT)}&period=month`,
);
await until(async () => (await page.locator('#results tbody tr').count()) > 0, 120000);
await dump('browse');
await page.evaluate(() => (document.getElementById('status').textContent = ''));
await page.selectOption('#privacy', 'public');
await page.waitForTimeout(1500);
await dump('1.5s after public');
await until(
  async () => /Read|Nothing|Answered|Could/.test(await page.locator('#status').innerText()),
  20000,
);
await dump('after wait');
console.log('badges', (await page.locator('#results tbody .badge').allInnerTexts()).slice(0, 6));
await browser.close();
gw.kill();
