// Opens the E2E build against the fixture gateway and dumps what the page did. Usage: node e2e/debug.mjs [driveId]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PORT = 8787;
const known = JSON.parse(readFileSync('fixtures/synthetic/known.json', 'utf8'));
const DRIVE = process.argv[2] || known.typicalDrive;
const gw = spawn('node', ['tools/fixture-gateway/server.mjs', '--site', 'apps/ardrive-explorer/dist-e2e', '--port', String(PORT)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 500)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
const dump = async (label) => {
  const st = await page.evaluate(() => {
    const s = window.__explorer.store;
    const d = s.drive.value;
    return {
      status: s.status.value.text, title: s.content.value.title, sub: s.content.value.sub, cost: !!s.content.value.cost, view: s.view.value,
      drive: d ? { items: d.items.length, roots: d.roots.length, name: d.name, files: d.files, folders: d.folders.size } : null,
      ui: s.driveUi.value, trace: s.trace.slice(-12), progress: s.progress.value.note,
    };
  });
  console.log(`--- ${label}`, JSON.stringify(st, null, 1).slice(0, 2500));
};
try {
  await page.goto(`http://localhost:${PORT}/#gw=${encodeURIComponent('http://localhost:' + PORT)}&period=month`);
  await until(async () => (await page.locator('#proof').getAttribute('data-state')) !== 'run', 60000);
  console.log('proof', await page.locator('#proof-text').innerText());
  await until(async () => (await page.locator('#results tbody tr').count()) > 0, 120000);
  await dump('after browse');
  const t0 = Date.now();
  await page.fill('#find', DRIVE);
  await page.click('#findgo');
  await until(async () => (await page.locator('#b-list tbody tr.b-row').count()) > 0 || (await page.locator('#cost').isVisible()), 60000);
  console.log(`drive after ${Date.now() - t0} ms, rows ${await page.locator('#b-list tbody tr.b-row').count()}`);
  await page.waitForTimeout(4000);
  await dump('after drive');
  console.log('head:', (await page.locator('.b-head').innerText().catch(() => '(none)')).replace(/\n/g, ' | '));
  console.log('crumbs:', await page.locator('#b-crumbs').innerText().catch(() => '(none)'));
  console.log('rows:', (await page.locator('#b-list tbody tr.b-row').allInnerTexts()).slice(0, 4));
  await page.screenshot({ path: 'e2e/out/debug.png', fullPage: true });
} catch (e) {
  console.log('HARNESS', String(e).slice(0, 500));
  await dump('at failure').catch(() => {});
}
await browser.close();
gw.kill();
