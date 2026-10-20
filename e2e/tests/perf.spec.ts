/**
 * Stress, ported from v0's test/perf.mjs: a drive that hits the 20,000-record
 * cap. Time to first rows, DOM size, the longest main-thread tasks, memory,
 * scroll-driven rendering, folder navigation and search while names stream.
 * The acceptance numbers are V1-ARCHITECTURE.md §4.2's.
 */
import { expect, test } from '@playwright/test';

import { driveRows, KNOWN, LIVE, openFolderMeasured, openPage, pageErrors, until } from './helpers.js';

// Thousands of record fetches make a trace slow to save; the numbers are in the log.
test.use({ trace: 'off' });

test('the 20,000-record drive: first rows, long tasks, windowed rendering, sorts', async ({ page }) => {
  test.setTimeout(LIVE ? 900_000 : 300_000);
  await openPage(page);
  await until(page, async () => (await page.locator('#results tbody tr').count()) > 0, 240_000, 'browse');
  await page.evaluate(() => {
    const w = window as unknown as { __lt: number[] };
    w.__lt = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__lt.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  });
  const longTasks = () => page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
  const maxLong = async () => Math.max(0, ...(await longTasks()));
  const mem = () => page.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : -1));
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const t0 = Date.now();
  await page.fill('#find', KNOWN.bigDrive);
  await page.click('#findgo');
  await until(page, async () => (await page.locator('#cost button').count()) > 0 || (await driveRows(page)) > 0, 120_000, 'drive or cost');
  if (await page.locator('#cost button').count()) {
    log('cost card:', (await page.locator('#cost').innerText()).slice(0, 120));
    await page.locator('#cost button').click();
    await until(page, async () => (await driveRows(page)) > 0, 600_000, 'rows');
  }
  const firstRows = (Date.now() - t0) / 1000;
  const head = (await page.locator('.b-head').innerText()).replace(/\n/g, ' | ');
  log(`first rows after ${firstRows.toFixed(1)}s | rows in DOM: ${await driveRows(page)} | head: ${head.slice(0, 200)}`);
  expect(await driveRows(page)).toBeLessThanOrEqual(201);
  expect(head).toMatch(/20,000|19,9\d\d/);
  if (LIVE) expect(firstRows).toBeLessThanOrEqual(12);
  log('heap', await mem(), 'MB | long tasks:', (await longTasks()).join(','), 'ms');
  log('trace:', (await page.evaluate(() => (window as unknown as { __explorer: { trace: string[] } }).__explorer.trace.slice(-14))).join(' | '));
  expect(await maxLong()).toBeLessThanOrEqual(130 + (LIVE ? 50 : 70));
  // scroll the list to the bottom repeatedly: windowed rendering should grow in chunks
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const w = document.querySelector('.b-listwrap')!;
      w.scrollTop = w.scrollHeight;
    });
    await page.waitForTimeout(600);
  }
  log('after scrolling: rows in DOM', await driveRows(page), '| more sentinel:', (await page.locator('#b-list .b-more').count()) ? await page.locator('#b-list .b-more').innerText() : 'none');
  // open the biggest folder
  const folderRows = page.locator('#b-list tbody tr.b-row').filter({ has: page.locator('.ico-folder') });
  const nf = await folderRows.count();
  if (nf) {
    let best = 0;
    let bestN = -1;
    for (let i = 0; i < Math.min(nf, 20); i++) {
      const t = await folderRows.nth(i).innerText();
      const m = /([\d,]+) items/.exec(t);
      const n = m ? Number(m[1]!.replace(/,/g, '')) : 0;
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    }
    const move = Math.round(await openFolderMeasured(page, best));
    await until(page, async () => (await driveRows(page)) > 0, 30_000, 'folder');
    log(`opened folder with ${bestN} items in ${move} ms | rows in DOM ${await driveRows(page)} | crumbs: ${await page.locator('#b-crumbs').innerText()}`);
    expect(move).toBeLessThanOrEqual(400);
    await page.evaluate(() => ((window as unknown as { __lt: number[] }).__lt.length = 0));
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const w = document.querySelector('.b-listwrap')!;
        w.scrollTop = w.scrollHeight;
      });
      await page.waitForTimeout(500);
    }
    log('after scrolling the folder: rows', await driveRows(page), '| long tasks', (await longTasks()).length, 'max', await maxLong(), 'ms | heap', await mem(), 'MB');
    expect(await maxLong()).toBeLessThanOrEqual(130 + 70);
    const t2 = Date.now();
    await page.locator('#b-list tbody tr.b-row').filter({ hasNot: page.locator('.ico-folder') }).filter({ hasNot: page.locator('.ico-up') }).nth(3).click();
    await page.waitForTimeout(300);
    log(`selected a file in ${Date.now() - t2} ms | details: ${(await page.locator('#b-details').innerText()).replace(/\n/g, ' | ').slice(0, 120)}`);
    expect(await page.locator('#b-details').isVisible()).toBe(true);
    const t3 = Date.now();
    await page.locator('#b-list tbody tr.b-up').click();
    await page.waitForTimeout(200);
    log(`back in ${Date.now() - t3} ms, rows ${await driveRows(page)}`);
  }
  // search while names stream
  await page.evaluate(() => ((window as unknown as { __lt: number[] }).__lt.length = 0));
  const t4 = Date.now();
  await page.fill('#b-filter', 'a');
  await page.waitForTimeout(1500);
  log(`search typed; ${Date.now() - t4} ms later rows ${await driveRows(page)} | sub: ${(await page.locator('#b-sub').innerText()).replace(/\n/g, ' | ')}`);
  await page.waitForTimeout(LIVE ? 20_000 : 8_000);
  log(`later: rows ${await driveRows(page)} | sub: ${(await page.locator('#b-sub').innerText()).replace(/\n/g, ' | ')} | long tasks ${(await longTasks()).length} max ${await maxLong()} ms | heap ${await mem()} MB`);
  expect(await maxLong()).toBeLessThanOrEqual(130 + 70);
  await page.fill('#b-filter', '');
  await page.waitForTimeout(500);
  log('cleared search: rows', await driveRows(page));
  // Sorts: click a header and wait for the next render (signals render in a microtask), measured in the page.
  const sorts = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const k of ['size', 'modified', 'name', 'type']) {
      const th = document.querySelector(`#b-list th[data-key="${k}"]`) as HTMLElement;
      const t = performance.now();
      th.click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      out[k] = Math.round(performance.now() - t);
    }
    return out;
  });
  log('in-page sort timings (ms):', sorts);
  for (const v of Object.values(sorts)) expect(v).toBeLessThanOrEqual(160 + 40);
  log('heap at the end', await mem(), 'MB');
  await page.locator('#view').screenshot({ path: 'e2e/out/bigdrive.png' });
  expect(pageErrors(page)).toEqual([]);
});
