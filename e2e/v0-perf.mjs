// Stress: a drive that hits the 20,000-record cap. Measures time to first
// rows, DOM size, the longest main-thread tasks, memory, scroll-driven
// rendering, folder navigation and search while names stream in.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:8080/';
const DRIVE = process.env.DRIVE || 'b76a5542-40c4-415c-8796-365d8dc365c7';
const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 300)));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
const rows = () => page.locator('#b-list tbody tr.b-row').count();
await page.goto(`${BASE}#gw=https%3A%2F%2Fturbo-gateway.com&period=month`);
await until(async () => (await page.locator('#results tbody tr').count()) > 0, 240000);
await page.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); });
const t0 = Date.now();
await page.fill('#find', DRIVE); await page.click('#findgo');
await until(async () => (await page.locator('#cost button').count()) > 0 || (await rows()) > 0, 120000);
if (await page.locator('#cost button').count()) { log('cost card:', (await page.locator('#cost').innerText()).slice(0, 120)); await page.locator('#cost button').click(); await until(async () => (await rows()) > 0, 600000); }
log(`first rows after ${((Date.now() - t0) / 1000).toFixed(1)}s | rows in DOM: ${await rows()} | head: ${(await page.locator('.b-head').innerText()).replace(/\n/g, ' | ').slice(0, 200)}`);
const mem = async () => page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : 'n/a');
log('heap', await mem(), '| long tasks so far:', await page.evaluate(() => window.__lt.length), 'max', await page.evaluate(() => Math.max(0, ...window.__lt)), 'ms');
// scroll the list to the bottom repeatedly: windowed rendering should grow in chunks
for (let i = 0; i < 6; i++) { await page.evaluate(() => { const w = document.querySelector('.b-listwrap'); w.scrollTop = w.scrollHeight; }); await page.waitForTimeout(600); }
log('after scrolling: rows in DOM', await rows(), '| more sentinel:', await page.locator('#b-list .b-more').innerText().catch(() => 'none'));
// open the biggest folder
const folderRows = page.locator('#b-list tbody tr.b-row').filter({ has: page.locator('.ico-folder') });
const nf = await folderRows.count();
if (nf) {
  let best = 0, bestN = -1;
  for (let i = 0; i < Math.min(nf, 20); i++) { const t = await folderRows.nth(i).innerText(); const m = /([\d,]+) items/.exec(t); const n = m ? Number(m[1].replace(/,/g, '')) : 0; if (n > bestN) { bestN = n; best = i; } }
  const t1 = Date.now(); await folderRows.nth(best).click(); await until(async () => (await rows()) > 0, 30000);
  log(`opened folder with ${bestN} items in ${Date.now() - t1} ms | rows in DOM ${await rows()} | crumbs: ${await page.locator('#b-crumbs').innerText()}`);
  await page.evaluate(() => { window.__lt.length = 0; });
  for (let i = 0; i < 8; i++) { await page.evaluate(() => { const w = document.querySelector('.b-listwrap'); w.scrollTop = w.scrollHeight; }); await page.waitForTimeout(500); }
  log('after scrolling the folder: rows', await rows(), '| long tasks', await page.evaluate(() => window.__lt.length), 'max', await page.evaluate(() => Math.max(0, ...window.__lt)), 'ms | heap', await mem());
  const t2 = Date.now(); await page.locator('#b-list tbody tr.b-row').filter({ hasNot: page.locator('.ico-folder') }).filter({ hasNot: page.locator('.ico-up') }).nth(3).click(); await page.waitForTimeout(300);
  log(`selected a file in ${Date.now() - t2} ms | details: ${(await page.locator('#b-details').innerText()).replace(/\n/g, ' | ').slice(0, 120)}`);
  const t3 = Date.now(); await page.locator('#b-list tbody tr.b-up').click(); await page.waitForTimeout(200); log(`back in ${Date.now() - t3} ms, rows ${await rows()}`);
}
// search while names stream
await page.evaluate(() => { window.__lt.length = 0; });
const t4 = Date.now(); await page.fill('#b-filter', 'a'); await page.waitForTimeout(1500);
log(`search typed; ${Date.now() - t4} ms later rows ${await rows()} | sub: ${(await page.locator('#b-sub').innerText()).replace(/\n/g, ' | ')}`);
await page.waitForTimeout(20000);
log(`20 s later: rows ${await rows()} | sub: ${(await page.locator('#b-sub').innerText()).replace(/\n/g, ' | ')} | long tasks ${await page.evaluate(() => window.__lt.length)} max ${await page.evaluate(() => Math.max(0, ...window.__lt))} ms | heap ${await mem()}`);
await page.fill('#b-filter', ''); await page.waitForTimeout(500);
log('cleared search: rows', await rows());
log('in-page sort timings (ms):', await page.evaluate(() => { const out = {}; for (const k of ['size', 'modified', 'name', 'type']) { const th = document.querySelector(`#b-list th[data-key="${k}"]`); const t = performance.now(); th.click(); out[k] = Math.round(performance.now() - t); } return out; }));
await page.locator('#view').screenshot({ path: '/tmp/claude-1000/-mnt-c-source-ar-io-index-explorers/c2b9da41-9552-4039-8c58-5e8e9f6f5ea1/scratchpad/v0/bigdrive.png' });
await browser.close();
