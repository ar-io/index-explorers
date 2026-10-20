import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const PORT = 8787;
const known = JSON.parse(readFileSync('fixtures/synthetic/known.json', 'utf8'));
const gw = spawn('node', ['tools/fixture-gateway/server.mjs', '--site', 'apps/ardrive-explorer/dist-e2e', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
await page.goto(`http://localhost:${PORT}/#gw=${encodeURIComponent('http://localhost:' + PORT)}&period=month&drive=${known.bigDrive}`);
await until(async () => (await page.locator('#b-list tbody tr.b-row').count()) > 0, 120000);
await page.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.start');
await page.fill('#b-filter', 'a');
await page.waitForTimeout(12000);
const { profile } = await cdp.send('Profiler.stop');
console.log('long tasks during search:', await page.evaluate(() => window.__lt.join(',')));
// self time per function
const self = new Map();
const dt = profile.timeDeltas; const samples = profile.samples; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (let i = 0; i < samples.length; i++) { const n = byId.get(samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); }
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
import('node:fs').then(({ readdirSync, readFileSync: rf }) => {
  const dir = 'apps/ardrive-explorer/dist-e2e/assets';
  const file = readdirSync(dir).find((f) => /^index-.*\.js$/.test(f));
  const lines = rf(`${dir}/${file}`, 'utf8').split('\n');
  for (const [k, us] of top) {
    const m = /:(\d+):(\d+)$/.exec(k);
    let snip = '';
    if (m && k.includes('index-')) { const l = lines[Number(m[1])] || ''; const c = Number(m[2]); snip = l.slice(Math.max(0, c - 60), c + 160).replace(/\n/g, ' '); }
    console.log((us / 1000).toFixed(0).padStart(6), 'ms', k, snip ? '\n        ' + snip : '');
  }
});
await browser.close(); gw.kill();
