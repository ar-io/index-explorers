import { expect, test } from '@playwright/test';

import {
  driveListed,
  driveRows,
  KNOWN,
  openPage,
  pageErrors,
  rows,
  status,
  until,
} from './helpers.js';

test('the page verifies the publication, lists drives with names, and opens a drive', async ({
  page,
}) => {
  await openPage(page, 'browse');
  expect(
    await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)),
  ).toBe(true);
  await until(page, async () => (await rows(page)) > 0, 120_000, 'browse');
  expect(await rows(page)).toBeGreaterThan(0);
  console.log('browse:', await status(page));
  await page.waitForTimeout(3000);
  const names = await page.locator('#results tbody .name').allInnerTexts();
  console.log('names:', names.slice(0, 5));
  expect(names.some((n) => !/fetching|unnamed|private|unavailable/i.test(n))).toBe(true);
  await page.fill('#find', KNOWN.typicalDrive);
  await page.click('#findgo');
  await driveListed(page, 60_000);
  console.log(
    'drive head:',
    (await page.locator('.b-head').innerText()).replace(/\n/g, ' | ').slice(0, 200),
  );
  await page.waitForTimeout(2000);
  console.log('crumbs:', await page.locator('#b-crumbs').innerText());
  console.log(
    'first rows:',
    (await page.locator('#b-list tbody tr.b-row').allInnerTexts()).slice(0, 3),
  );
  expect(pageErrors(page)).toEqual([]);
});
