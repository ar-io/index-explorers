/**
 * A file in a drive: its preview (an image, the start of a text), Download
 * under its own name, the row menu in the design system's order, and Open in
 * ArDrive at the app's public routes. Fixtures only: live, it would read
 * people's files to test the page.
 */
import { expect, test, type Page } from '@playwright/test';

import { driveListed, KNOWN, LIVE, openPage, until } from './helpers.js';

test.skip(LIVE, 'reads file data; checked against the fixture gateway');

const fileRow = (page: Page, re: RegExp) =>
  page
    .locator('#b-list tbody tr.b-row')
    .filter({ hasNot: page.locator('.ico-folder') })
    .filter({ has: page.locator('.name', { hasText: re }) })
    .first();

test('a file previews when selected, downloads under its name, and opens in ArDrive', async ({
  page,
}) => {
  await openPage(page, `drive=${KNOWN.typicalDrive}`);
  expect(await driveListed(page, 120_000)).toBe(true);
  await until(
    page,
    async () => (await fileRow(page, /\.(png|jpe?g)$/).count()) > 0,
    30_000,
    'image',
  );
  // An image: drawn from the gateway as soon as it is selected.
  await fileRow(page, /\.(png|jpe?g)$/).click();
  const img = page.locator('#preview img');
  await img.waitFor();
  await until(
    page,
    () => img.evaluate((i) => (i as HTMLImageElement).naturalWidth > 0),
    10_000,
    'img',
  );
  expect(await img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  // Open in ArDrive goes to the app's public file route.
  const href = await page
    .locator('#b-details a', { hasText: 'Open in ArDrive' })
    .getAttribute('href');
  expect(href).toMatch(/^https:\/\/app\.ardrive\.io\/#\/file\/[0-9a-f-]{36}\/view$/);
  // Download saves the bytes under the file's own name.
  const name = await page.locator('#b-details h3').innerText();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#d-download')]);
  expect(dl.suggestedFilename()).toBe(name);
  // A text: its first bytes, as text.
  await until(
    page,
    async () => (await fileRow(page, /\.(txt|json|html)$/).count()) > 0,
    30_000,
    'text',
  );
  await fileRow(page, /\.(txt|json|html)$/).click();
  await until(page, async () => (await page.locator('#preview pre').count()) > 0, 10_000, 'text');
  expect(await page.locator('#preview pre').innerText()).toMatch(/line 1: fixture text/);
  // The row menu, in the kit's order, each item with its icon.
  await fileRow(page, /\.(txt|json|html)$/)
    .locator('.b-act button')
    .click();
  const items = page.locator('#b-rowmenu [role=menuitem]');
  expect((await items.allInnerTexts()).map((t) => t.trim())).toEqual([
    'Preview',
    'Copy link',
    'Download',
    'Open in ArDrive',
    'More info',
  ]);
  expect(await page.locator('#b-rowmenu [role=menuitem] .ico').count()).toBe(5);
  await page.keyboard.press('Escape');
  // The drive's own menu: More info opens the drive's details, ArFS version and all.
  await page.click('#viewmenu');
  await page.locator('#viewmenu-menu [role=menuitem]', { hasText: 'More info' }).click();
  expect(await page.locator('#b-details').innerText()).toMatch(/Drive-Id[\s\S]*ArFS/);
  expect(
    await page.locator('#b-details a', { hasText: 'Open in ArDrive' }).getAttribute('href'),
  ).toBe(`https://app.ardrive.io/#/drives/${KNOWN.typicalDrive}`);
});

test('on a phone, a tapped file opens its details in a bottom sheet, in view', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  await openPage(page, `drive=${KNOWN.typicalDrive}`);
  expect(await driveListed(page, 120_000)).toBe(true);
  await until(
    page,
    async () => (await fileRow(page, /\.(png|jpe?g)$/).count()) > 0,
    30_000,
    'image',
  );
  await fileRow(page, /\.(png|jpe?g)$/).tap();
  const sheet = page.locator('.sheet[role=dialog]');
  await sheet.waitFor();
  expect(await sheet.locator('#b-details #preview').count()).toBe(1);
  // Once it has risen (a 0.18 s slide).
  await page.waitForTimeout(400);
  const box = (await sheet.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(845);
  expect(box.y).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await until(page, async () => (await sheet.count()) === 0, 5_000, 'closed');
  expect(await page.locator('#b-details').count()).toBe(0);
  await ctx.close();
});

test("a drive's row in Newest drives has the drive's menu: Open, Copy link, Open in ArDrive", async ({
  page,
}) => {
  await openPage(page, 'browse');
  await until(
    page,
    async () => (await page.locator('#results tbody tr').count()) > 0,
    120_000,
    'browse',
  );
  const row = page
    .locator('#results tbody tr')
    .filter({ has: page.locator('.privacy', { hasText: 'Public' }) })
    .first();
  await row.locator('td.row-act button').click();
  const items = page.locator('#drive-rowmenu [role=menuitem]');
  expect((await items.allInnerTexts()).map((t) => t.trim())).toEqual([
    'Open',
    'Copy link',
    'Open in ArDrive',
  ]);
  await items.filter({ hasText: 'Open' }).first().click();
  await until(
    page,
    async () =>
      (await page.locator('#b-list tbody tr.b-row').count()) > 0 ||
      (await page.locator('#cost').isVisible()),
    120_000,
    'drive',
  );
  expect(await page.evaluate(() => location.hash)).toMatch(/drive=/);
});
