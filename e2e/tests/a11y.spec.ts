/**
 * The ArDrive explorer against WCAG 2.1 A and AA (axe-core), as the ArDrive
 * design system asks ("Accessible by default"): the home page, a listing, an
 * open drive with a file's details, a question with the SQL editor open, and
 * an open menu, in both themes, on a laptop and a phone. Any violation fails,
 * with its rule, its impact and the elements it found.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { countsShown, driveListed, KNOWN, LIVE, openPage, rows, until } from './helpers.js';

// Markup and colour are the same against any gateway: checked on fixtures, with no live reads.
test.skip(LIVE, 'the same page live; checked on the fixture gateway');

async function violations(page: Page, where: string): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  return r.violations.map(
    (v) =>
      `${where}: ${v.id} (${v.impact}) ${v.help} at ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(', ')}`,
  );
}

for (const colorScheme of ['dark', 'light'] as const)
  for (const width of [1440, 390])
    test(`no WCAG 2.1 AA violations, ${colorScheme}, ${width} px`, async ({ browser }) => {
      test.setTimeout(300_000);
      // axe reads frames through an explicit context.
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const page = await context.newPage();
      const found: string[] = [];
      await openPage(page);
      await until(page, () => countsShown(page), 60_000, 'counts');
      found.push(...(await violations(page, 'home')));
      await page.locator('#browse').click();
      await until(page, async () => (await rows(page)) > 0, 120_000, 'browse');
      found.push(...(await violations(page, 'newest drives')));
      await page.locator('#privacy').click();
      found.push(...(await violations(page, 'a menu open')));
      await page.keyboard.press('Escape');
      await openPage(page, `drive=${KNOWN.typicalDrive}`);
      expect(await driveListed(page, 120_000)).toBe(true);
      await page.waitForTimeout(2000);
      await page
        .locator('#b-list tbody tr.b-row')
        .filter({ hasNot: page.locator('.ico-folder') })
        .first()
        .click();
      await page.locator('#b-details').waitFor();
      found.push(...(await violations(page, 'a drive and a file')));
      await page.locator('#asks button', { hasText: 'Biggest files' }).click();
      await until(page, async () => (await rows(page)) > 0, 60_000, 'question');
      await page.locator('#editor > summary').click();
      found.push(...(await violations(page, 'a question and the SQL')));
      await context.close();
      expect(found).toEqual([]);
    });

test('a menu works from the keyboard, as the design system says', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await openPage(page);
  await until(page, () => countsShown(page), 60_000, 'counts');
  const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
  const active = () =>
    page.evaluate(() => {
      const m = document.getElementById('privacy-menu');
      const id = m?.getAttribute('aria-activedescendant');
      return id ? (document.getElementById(id)?.dataset.value ?? '') : '';
    });
  // Down opens the menu on the current value; Down moves; Enter picks and returns focus.
  await page.locator('#privacy').focus();
  await page.keyboard.press('ArrowDown');
  await page.locator('#privacy-menu').waitFor();
  expect(await active()).toBe('any');
  expect(
    await page.locator('#privacy-menu [aria-selected="true"]').getAttribute('data-value'),
  ).toBe('any');
  await page.keyboard.press('ArrowDown');
  expect(await active()).toBe('public');
  await page.keyboard.press('Enter');
  expect(await page.locator('#privacy-menu').count()).toBe(0);
  expect(await page.locator('#privacy').getAttribute('data-value')).toBe('public');
  expect(await focused()).toBe('privacy');
  // Escape closes without picking, and focus returns.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  expect(await page.locator('#privacy-menu').count()).toBe(0);
  expect(await page.locator('#privacy').getAttribute('data-value')).toBe('public');
  expect(await focused()).toBe('privacy');
  // A row's menu: Enter on its button opens it, and More info opens the details.
  await openPage(page, `drive=${KNOWN.typicalDrive}`);
  expect(await driveListed(page, 120_000)).toBe(true);
  const button = page
    .locator('#b-list tbody tr.b-row')
    .filter({ hasNot: page.locator('.ico-folder') })
    .first()
    .locator('.b-act button');
  await button.focus();
  await page.keyboard.press('Enter');
  await page.locator('#b-rowmenu').waitFor();
  expect(await button.getAttribute('aria-expanded')).toBe('true');
  await page.locator('#b-rowmenu [role=menuitem]', { hasText: 'More info' }).click();
  await page.locator('#b-details').waitFor();
  expect(await page.locator('#b-rowmenu').count()).toBe(0);
  await context.close();
});
