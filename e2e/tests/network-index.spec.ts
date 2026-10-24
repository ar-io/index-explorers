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
    // Resolve a data item: published bands first, every byte checked.
    const resolved = (re: RegExp) =>
      until(
        page,
        async () => re.test(await page.locator('#status').innerText()),
        LIVE ? 240_000 : 60_000,
        'resolve',
      );
    const id = LIVE ? '4aCplvNxtUx2DnpUUhhGkecFXiUDJFYhZDlra8ClGXA' : KNOWN.fileRecord;
    await page.fill('#q', id);
    await page.click('#findgo');
    await resolved(/Found|Not (in any|found)|Could not/);
    const st = await page.locator('#status').innerText();
    expect(st, st).toMatch(/Found in .* a band .* signed/);
    expect(await page.locator('#result .source').innerText()).toMatch(
      /matched against the band's torrent/,
    );
    expect(await page.locator('#root').innerText()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await page.locator('.checks li[data-k="pieces"]').getAttribute('data-state')).toBe('ok');
    expect(await page.locator('.stage[data-k="record"]').getAttribute('data-state')).toBe('done');
    expect(await page.locator('#packs li[data-s="hit"]').count()).toBe(1);
    // A random id is not found, honestly.
    await page.fill('#q', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await page.click('#findgo');
    await resolved(/Not (in any|found)|Found|Could not/);
    expect(await page.locator('#status').innerText()).toMatch(/Not (in any|found)/);
    // A pasted URL gives up its id.
    await page.fill('#q', `https://example.com/${id}?x=1`);
    await page.click('#findgo');
    await resolved(/Found|Not (in any|found)|Could not/);
    expect(await page.inputValue('#q')).toBe(id);
    if (LIVE) {
      // The original page's example lives in the packs on Arweave, and is checked against the data.
      await page.click('#example');
      await resolved(/Found in the .* pack|Not (in any|found)|Could not/);
      expect(await page.locator('#status').innerText()).toMatch(/Found in the .* pack/);
      expect(await page.locator('#root').innerText()).toBe(
        'gjLyC5Vwfrxumo-54oL8gAUb00B9pc63cQm0BRstrLo',
      );
      await until(
        page,
        async () => (await page.locator('#checks li[data-s="wait"]').count()) === 0,
        60_000,
        'check',
      );
      expect(await page.locator('#checks li[data-s="bad"]').count()).toBe(0);
    }
    // The original page's links, #<id>, still run the lookup.
    await page.goto(`${BASE}#${id}`);
    await page.reload();
    await resolved(/Found|Not (in any|found)|Could not/);
    expect(await page.inputValue('#q')).toBe(id);
    expect(await page.locator('#status').innerText()).toMatch(/Found/);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'e2e/out/network-index.png', fullPage: true });
  });
});
