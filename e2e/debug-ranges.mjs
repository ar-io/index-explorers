// Which ranges the page asks the range reader for while it opens the big
// drive, live, by phase. Serve the production build on 8797 first.
import { chromium } from '@playwright/test';

const BASE = process.env.LIVE_BASE || 'http://localhost:8797/';
const DRIVE = 'b76a5542-40c4-415c-8796-365d8dc365c7';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const reqs = [];
let t0 = 0;
ctx.on('request', (r) => {
  const u = r.url();
  const at = u.indexOf('/__bt__/');
  if (at < 0 || !t0) return;
  let f = '?';
  try {
    const spec = JSON.parse(
      Buffer.from(
        decodeURIComponent(u.slice(at + 8))
          .replace(/-/g, '+')
          .replace(/_/g, '/'),
        'base64',
      ).toString(),
    );
    f = `${spec.label || spec.f}`;
  } catch {
    f = u.slice(at + 8, at + 40);
  }
  reqs.push({ t: Date.now() % 100000, m: r.method(), f, range: r.headers()['range'] || '' });
});
await page.goto(BASE);
for (let i = 0; i < 2400; i++) {
  if (await page.locator('#results tbody tr').count()) break;
  await page.waitForTimeout(100);
}
t0 = Date.now();
await page.fill('#find', DRIVE);
await page.click('#findgo');
for (let i = 0; i < 1200; i++) {
  if (await page.locator('#cost button').count()) await page.locator('#cost button').click();
  if (await page.locator('#b-list tbody tr.b-row').count()) break;
  await page.waitForTimeout(100);
}
console.log('first rows', (Date.now() - t0) / 1000);
const trace = await page.evaluate(() => window.__explorer.store.trace.slice(-16));
console.log(trace.join(' | '));
console.log('now', Date.now() % 100000, 't0', t0 % 100000);
for (const r of reqs) {
  const m = /bytes=(\d+)-(\d+)/.exec(r.range);
  const len = m ? Number(m[2]) - Number(m[1]) + 1 : 0;
  console.log(r.t, r.m, r.f, r.range, len);
}
await browser.close();
