/**
 * Navigation, ported from v0's test/nav.mjs: folders, breadcrumbs, Back and
 * Forward through the browser history, a copied link landing inside a folder,
 * and the timing of each move (folder moves ≤ 400 ms).
 *
 * On fixtures the drive's known two-level folder anchors the walk; live, the
 * first folder that has a subfolder is used.
 */
import { expect, test, type Page } from '@playwright/test';

import { driveRows, GW, KNOWN, LIVE, openFolderMeasured, openPage, pageErrors, title, until } from './helpers.js';

const log = (...a: unknown[]) => console.log(...a);
const crumbCount = (page: Page) => page.locator('#b-crumbs .crumb').count();
const crumbs = (page: Page) => page.locator('#b-crumbs').innerText().catch(() => '');
const frag = (page: Page) => page.evaluate(() => decodeURIComponent(location.hash).replace(/gw=[^&]+&/, ''));
const folderRows = (page: Page) => page.locator('#b-list tbody tr.b-row').filter({ has: page.locator('.ico-folder') });

/** Opens the first folder in the current listing; true when one existed. */
async function intoFolder(page: Page): Promise<number | null> {
  if (!(await folderRows(page).count())) return null;
  const before = await crumbCount(page);
  const ms = Math.round(await openFolderMeasured(page, 0));
  await until(page, async () => (await crumbCount(page)) === before + 1, 5000, 'into folder');
  return ms;
}

test('a folder opens within the budget and lands in the fragment', async ({ page }) => {
  await openPage(page, `drive=${KNOWN.typicalDrive}`);
  await until(page, async () => (await driveRows(page)) > 0, 240_000, 'drive');
  await page.waitForTimeout(LIVE ? 6000 : 2500);
  log('1 drive open   |', await crumbs(page), '|', await frag(page));
  const move = await intoFolder(page);
  expect(move).not.toBeNull();
  log(`2 into folder ${move} ms |`, await crumbs(page), '|', await frag(page));
  expect(move!).toBeLessThanOrEqual(400);
  expect(await crumbCount(page)).toBe(2);
  expect(await frag(page)).toMatch(/folder=/);
  expect(pageErrors(page)).toEqual([]);
});

test('Back/Forward, crumbs and a link walk the exact folder', async ({ page, browser }) => {
  // Reach a folder two levels deep: by its id on fixtures, by walking live.
  if (KNOWN.deepFolder) await openPage(page, `drive=${KNOWN.typicalDrive}&folder=${KNOWN.deepFolder}`);
  else await openPage(page, `drive=${KNOWN.typicalDrive}`);
  await until(page, async () => (await driveRows(page)) > 0, 240_000, 'drive');
  await page.waitForTimeout(LIVE ? 6000 : 2500);
  if (!KNOWN.deepFolder) {
    // Walk: open folders until two levels deep, trying each top folder in turn.
    const n = await folderRows(page).count();
    for (let i = 0; i < n && (await crumbCount(page)) < 3; i++) {
      await folderRows(page).nth(i).click();
      await page.waitForTimeout(400);
      if ((await folderRows(page).count()) > 0) {
        await folderRows(page).first().click();
        await page.waitForTimeout(400);
      } else {
        await page.locator('#b-crumbs .crumb').first().click();
        await page.waitForTimeout(300);
      }
    }
  }
  expect(await crumbCount(page), 'two levels deep').toBe(3);
  const deepFrag = await frag(page);
  const deepCrumbs = await crumbs(page);
  log('1 deep folder  |', deepCrumbs, '|', deepFrag);
  // Up through the crumbs: each a history entry.
  let t = Date.now();
  await page.locator('#b-crumbs .crumb').nth(1).click();
  await until(page, async () => (await crumbCount(page)) === 2, 5000, 'crumb up');
  log(`2 crumb up ${Date.now() - t} ms |`, await crumbs(page), '|', await frag(page));
  expect(Date.now() - t).toBeLessThanOrEqual(650);
  await page.locator('#b-crumbs .crumb').first().click();
  await until(page, async () => (await crumbCount(page)) === 1, 5000, 'crumb root');
  log('3 crumb root   |', await crumbs(page), '|', await frag(page));
  expect(await frag(page)).not.toMatch(/folder=/);
  // Back twice returns to the deep folder exactly; Forward twice returns to the root.
  t = Date.now();
  await page.goBack();
  await until(page, async () => (await crumbCount(page)) === 2, 5000, 'back 1');
  log(`4 Back ${Date.now() - t} ms |`, await crumbs(page), '|', await frag(page));
  await page.goBack();
  await until(page, async () => (await crumbCount(page)) === 3, 5000, 'back 2');
  log('5 Back         |', await crumbs(page), '|', await frag(page));
  expect(await crumbs(page)).toBe(deepCrumbs);
  expect(await frag(page)).toBe(deepFrag);
  await page.goForward();
  await until(page, async () => (await crumbCount(page)) === 2, 5000, 'fwd 1');
  await page.goForward();
  await until(page, async () => (await crumbCount(page)) === 1, 5000, 'fwd 2');
  log('6 Forward ×2   |', await crumbs(page), '|', await frag(page));
  expect(await crumbCount(page)).toBe(1);
  await page.goBack();
  await page.goBack();
  await until(page, async () => (await crumbCount(page)) === 3, 5000, 'back to deep');
  log('7 Back to deep |', await crumbs(page), '| ok:', (await crumbs(page)) === deepCrumbs);
  expect(await crumbs(page)).toBe(deepCrumbs);
  // A link into the deep folder opens there.
  const p2 = await browser.newPage({ colorScheme: 'dark' });
  await p2.goto('/' + (deepFrag.startsWith('#') ? deepFrag : '#' + deepFrag).replace('#period', `#gw=${encodeURIComponent(GW)}&period`));
  await until(p2, async () => (await p2.locator('#b-list tbody tr.b-row').count()) > 0 && (await p2.locator('#b-crumbs .crumb').count()) === 3, 180_000, 'link lands');
  await p2.waitForTimeout(LIVE ? 3000 : 1500);
  log('8 link lands in folder |', await p2.locator('#b-crumbs').innerText(), '| ok:', (await p2.locator('#b-crumbs').innerText()) === deepCrumbs);
  expect(await p2.locator('#b-crumbs').innerText()).toBe(deepCrumbs);
  await p2.close();
  // Owner → wallet → Back returns to the drive at the same folder.
  await page.locator('.b-owner').click();
  await until(page, async () => /Wallet/.test(await title(page)), 120_000, 'wallet');
  await page.waitForTimeout(500);
  log('9 wallet       |', await title(page));
  t = Date.now();
  await page.goBack();
  await until(page, async () => (await driveRows(page)) > 0 && (await crumbCount(page)) === 3, 120_000, 'back to drive');
  await page.waitForTimeout(500);
  log(`10 Back to drive ${Date.now() - t} ms |`, await crumbs(page), '| ok:', (await crumbs(page)) === deepCrumbs);
  expect(await crumbs(page)).toBe(deepCrumbs);
  // Browse, then Back returns again.
  await page.locator('#browse').click();
  await until(page, async () => (await page.locator('#results tbody tr').count()) > 0, 120_000, 'browse');
  await page.goBack();
  await until(page, async () => (await driveRows(page)) > 0 && (await crumbCount(page)) === 3, 120_000, 'back again');
  await page.waitForTimeout(300);
  log('11 browse then Back |', await crumbs(page));
  expect(await crumbs(page)).toBe(deepCrumbs);
  await page.locator('#view').screenshot({ path: 'e2e/out/nav.png' });
  expect(pageErrors(page)).toEqual([]);
});
