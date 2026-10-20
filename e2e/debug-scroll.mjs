import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const PORT = 8787;
const known = JSON.parse(readFileSync('fixtures/synthetic/known.json', 'utf8'));
const gw = spawn('node', ['tools/fixture-gateway/server.mjs', '--site', 'apps/ardrive-explorer/dist-e2e', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
await page.goto(`http://localhost:${PORT}/#gw=${encodeURIComponent('http://localhost:' + PORT)}&period=month&drive=${known.bigDrive}`);
await until(async () => (await page.locator('#b-list tbody tr.b-row').count()) > 0, 120000);
await page.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); });
for (let i = 0; i < 4; i++) {
  const t = Date.now();
  await page.evaluate(() => { const w = document.querySelector('.b-listwrap'); w.scrollTop = w.scrollHeight; });
  const te = Date.now() - t;
  await page.waitForTimeout(600);
  const n = await page.locator('#b-list tbody tr.b-row').count();
  const info = await page.evaluate(() => ({ lt: window.__lt.slice(-5), names: window.__explorer.store.namesProgress.value, pending: window.__explorer.session.names.pending }));
  console.log(`scroll ${i}: evaluate ${te} ms, rows ${n}`, JSON.stringify(info));
}
await browser.close(); gw.kill();
