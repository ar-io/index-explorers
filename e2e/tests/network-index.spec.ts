/**
 * The network index page: the publication verifies, every index is listed with
 * its bands, and a data item resolves to its root transaction through verified
 * range reads. On fixtures the item is a known record; live, one from the L2 band.
 */
import { expect, test } from '@playwright/test';

import { GW, KNOWN, LIVE, until } from './helpers.js';

const BASE = process.env.NI_BASE || '/network-index/';

test.describe('network-index', () => {
  test('verifies, lists every index, and resolves a data item with verified reads', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}#gw=${encodeURIComponent(GW)}`);
    await until(
      page,
      async () => (await page.locator('#proof').getAttribute('data-state')) !== 'run',
      90_000,
      'proof',
    );
    expect(
      await page.locator('#proof').getAttribute('data-state'),
      await page.locator('#proof-text').innerText(),
    ).toBe('ok');
    await until(
      page,
      async () => (await page.locator('.panel.index').count()) > 0,
      30_000,
      'indexes',
    );
    const names = await page.locator('.panel.index .panel-title code').allInnerTexts();
    expect(names).toContain('root-tx-index');
    expect(names).toContain('parquet-l1');
    expect(names).toContain('ardrive-l2');
    expect(await page.locator('#s-bands').innerText()).not.toBe('—');
    // Band rows and their files.
    const firstBand = page.locator('#index-ardrive-l2 .band-row').first();
    await firstBand.click();
    expect(await page.locator('#index-ardrive-l2 .files tr').count()).toBeGreaterThan(3);
    expect(await page.locator('#index-ardrive-l2 .band-files').innerText()).toMatch(/infohash/);
    // The commands to run a copy.
    expect(await page.locator('#index-ardrive-l2 .guide pre').first().textContent()).toMatch(
      /index-swarm-setup --subscribe/,
    );
    // Resolve a data item.
    const id = LIVE ? '4aCplvNxtUx2DnpUUhhGkecFXiUDJFYhZDlra8ClGXA' : KNOWN.fileRecord;
    await page.fill('#find', id);
    await page.click('#findgo');
    await until(
      page,
      async () => /Found|Not in any|Could not/.test(await page.locator('#status').innerText()),
      LIVE ? 240_000 : 60_000,
      'resolve',
    );
    const st = await page.locator('#status').innerText();
    expect(st, st).toMatch(/Found in/);
    expect(st).toMatch(/verified range reads/);
    expect(await page.locator('#lookup .facts').innerText()).toMatch(/root transaction/i);
    expect(await page.locator('.checks li[data-k="pieces"]').getAttribute('data-state')).toBe('ok');
    // A random id is not found, honestly.
    await page.fill('#find', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await page.click('#findgo');
    await until(
      page,
      async () => /Not in any|Found|Could not/.test(await page.locator('#status').innerText()),
      60_000,
      'miss',
    );
    expect(await page.locator('#status').innerText()).toMatch(/Not in any/);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'e2e/out/network-index.png', fullPage: true });
  });
});
