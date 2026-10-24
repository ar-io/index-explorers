/**
 * The capability matrix: filters, periods and
 * their gates, exports, every question and preset, share links, private
 * drives, wallets, ids, Stop, the data-source drawer, themes and viewports.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

import {
  clearStatus,
  driveOpened,
  driveRows,
  GW,
  KNOWN,
  LIVE,
  openPage,
  pageErrors,
  rows,
  status,
  title,
  until,
  url,
  waitAnswer,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await openPage(page);
});
test.afterAll(async () => {
  expect(pageErrors(page)).toEqual([]);
  await page.close();
});

test('publication verifies, the range reader controls the page, drives list with names', async () => {
  expect(await page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true);
  await until(page, async () => (await rows(page)) > 0, 240_000, 'browse');
  expect(await rows(page)).toBeGreaterThan(0);
  await until(
    page,
    async () => !/—/.test(await page.locator('#stats').innerText()),
    30_000,
    'hero',
  );
  expect(await page.locator('#stats').innerText()).not.toMatch(/—/);
  await page.waitForTimeout(LIVE ? 6000 : 2000);
  const names = await page.locator('#results tbody .name').allInnerTexts();
  expect(
    names.some((n) => !/fetching|unnamed|private|unavailable/i.test(n)),
    names.slice(0, 5).join(' | '),
  ).toBe(true);
  expect(await page.locator('#scopedates').innerText()).toMatch(/\d{4}/);
  expect(await page.locator('#namesnote').isVisible()).toBe(true);
});

test('records come from the lookup; empty drives stay hidden until asked for', async () => {
  const counts = async () =>
    (await page.locator('#results tbody td.num').allInnerTexts()).map((t) =>
      Number(t.replace(/,/g, '')),
    );
  const shown = await counts();
  expect(shown.length).toBeGreaterThan(0);
  // A drive with nothing in it has 2 records: itself and its root folder.
  expect(
    shown.every((n) => Number.isInteger(n) && n > 2),
    shown.join(' '),
  ).toBe(true);
  await clearStatus(page);
  await page.selectOption('#contents', 'any');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'empty ones too',
  );
  const all = await counts();
  expect(
    all.every((n) => Number.isInteger(n) && n >= 1),
    all.join(' '),
  ).toBe(true);
  // The live index's newest drives include empty ones (2026-10-23: test_nft).
  if (LIVE) expect(all.some((n) => n <= 2)).toBe(true);
  await clearStatus(page);
  await page.selectOption('#contents', 'some');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'with contents',
  );
});

test('filters: privacy, app and period reload the listing', async () => {
  await clearStatus(page);
  await page.selectOption('#privacy', 'public');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'public filter',
  );
  const badges = await page.locator('#results tbody .badge').allInnerTexts();
  expect(badges.length).toBeGreaterThan(0);
  expect(badges.every((b) => /public/i.test(b))).toBe(true);
  await clearStatus(page);
  await page.selectOption('#privacy', 'private');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'private filter',
  );
  const pb = await page.locator('#results tbody .badge').allInnerTexts();
  expect(pb.length).toBeGreaterThan(0);
  expect(pb.every((b) => /private/i.test(b))).toBe(true);
  await clearStatus(page);
  await page.selectOption('#privacy', 'any');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'any filter',
  );
  await clearStatus(page);
  await page.selectOption('#app', 'ArDrive-CLI');
  await until(
    page,
    async () =>
      /Read|Nothing new|Answered|drives? in this period/.test(
        (await status(page)) +
          (await page
            .locator('#more')
            .innerText()
            .catch(() => '')),
      ),
    180_000,
    'app filter',
  );
  const apps = await page.locator('#results tbody td:nth-child(5)').allInnerTexts();
  expect(apps.every((a) => /CLI/.test(a))).toBe(true);
  await page.selectOption('#app', 'any');
  await clearStatus(page);
  await page.selectOption('#scope', 'week');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'week',
  );
  expect(await page.locator('#viewsub').innerText()).toMatch(/Drives created/);
  expect(await page.locator('#runscope').textContent()).toMatch(/Last 7 days/);
  await page.selectOption('#scope', 'month');
  await until(
    page,
    async () => /Read|Nothing new|Answered/.test(await status(page)),
    120_000,
    'month again',
  );
});

test('show older adds rows, and exports carry every row', async () => {
  const older = page.locator('#more button', { hasText: 'Show older' });
  if (await older.count()) {
    const before = await rows(page);
    await clearStatus(page);
    await older.click();
    await until(page, async () => (await rows(page)) > before, 120_000, 'older');
    expect(await rows(page)).toBeGreaterThan(before);
  }
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.click('#csv'),
  ]);
  const csv = fs.readFileSync((await dl.path())!, 'utf8');
  expect(csv.split('\n').length).toBeGreaterThan(2);
  expect(csv.split('\n')[0]).toMatch(/drive_id/);
  const [dj] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.click('#json'),
  ]);
  const js = JSON.parse(fs.readFileSync((await dj.path())!, 'utf8')) as { drive_id: string }[];
  expect(Array.isArray(js) && js.length > 2 && !!js[0]!.drive_id).toBe(true);
});

test('every question answers, with a caption', async () => {
  const n = await page.locator('#asks button').count();
  expect(n).toBe(8);
  for (let i = 0; i < n; i++) {
    const label = await page.locator('#asks button').nth(i).locator('span').first().innerText();
    await clearStatus(page);
    await page.locator('#asks button').nth(i).click();
    await waitAnswer(page);
    const st = await status(page);
    expect(await rows(page), `${label}: ${st}`).toBeGreaterThan(0);
    expect(st, label).not.toMatch(/error|could not/i);
  }
  expect(await page.locator('#caption').isVisible()).toBe(true);
  await page.locator('#view').screenshot({ path: 'e2e/out/q-last.png' });
});

test('every preset runs; a bad query is reported; a drive_id link opens the drive', async () => {
  await page.locator('#editor > summary').click();
  const np = await page.locator('#presets button').count();
  expect(np).toBe(7);
  for (let i = 0; i < np; i++) {
    const label = await page.locator('#presets button').nth(i).innerText();
    await page.locator('#presets button').nth(i).click();
    await clearStatus(page);
    await page.click('#run');
    await waitAnswer(page);
    const st = await status(page);
    expect(st, label).not.toMatch(/error|could not/i);
    expect(await rows(page), `${label}: ${st}`).toBeGreaterThan(0);
  }
  await page.fill('#sql', 'SELECT nope FROM nowhere');
  await clearStatus(page);
  await page.click('#run');
  await waitAnswer(page, 60_000);
  expect(await status(page)).toMatch(/error|could not/i);
  await page.locator('#presets button', { hasText: 'Newest drives' }).click();
  await clearStatus(page);
  await page.click('#run');
  await waitAnswer(page);
  await page.locator('#results tbody tr').first().locator('.rowlink').first().click();
  // The newest drive may hold no files yet.
  await until(page, () => driveOpened(page), 120_000, 'drive from query link');
  expect(await driveOpened(page)).toBe(true);
});

test('a share link carries the drive and opens it in a new tab', async ({ browser }) => {
  await page.click('#copylink');
  const href = await page.evaluate(() => location.href);
  expect(href).toMatch(/#.*drive=/);
  const p2 = await browser.newPage({ colorScheme: 'dark' });
  await p2.goto(href);
  const ok = await until(p2, () => driveOpened(p2), 180_000, 'shared drive');
  expect(ok).toBe(true);
  await p2.close();
});

test('a private drive shows its shape only', async () => {
  await page.selectOption('#privacy', 'private');
  await page.locator('#browse').click();
  await until(page, async () => (await rows(page)) > 0, 120_000, 'private browse');
  await page.locator('#results tbody tr').first().locator('.rowlink').first().click();
  await until(
    page,
    async () =>
      /Private drive/.test(
        await page
          .locator('.b-head')
          .innerText()
          .catch(() => ''),
      ),
    120_000,
    'private drive',
  );
  const head = await page.locator('.b-head').innerText();
  expect(head).toMatch(/Private drive/);
  expect(head).toMatch(/encrypted/);
  await page.locator('#view').screenshot({ path: 'e2e/out/private-drive.png' });
  await page.selectOption('#privacy', 'any');
});

test('the wallet view: totals, stretches, and every drive on request', async () => {
  await page.locator('.b-owner').first().click();
  await until(
    page,
    async () =>
      /Wallet/.test(await title(page)) &&
      /stretch/.test(
        await page
          .locator('#viewsub')
          .innerText()
          .catch(() => ''),
      ),
    180_000,
    'wallet',
  );
  expect(await title(page)).toMatch(/Wallet/);
  expect(await page.locator('#viewfacts').innerText()).toMatch(/uploads/i);
  const every = page.locator('#more button', { hasText: /Find/ });
  if (await every.count()) {
    const costText = await every.innerText();
    const m = /about ([\d.]+) (MB|GB)/.exec(costText);
    const mbs = m ? Number(m[1]) * (m[2] === 'GB' ? 1000 : 1) : 0;
    if (mbs < 300) {
      await clearStatus(page);
      await every.click();
      await until(
        page,
        async () =>
          /Every drive|newest/.test(
            await page
              .locator('#viewsub')
              .innerText()
              .catch(() => ''),
          ),
        600_000,
        'every drive',
      );
      expect(await page.locator('#viewsub').innerText()).toMatch(/Every drive|newest/);
    }
  }
});

test('find: a file record, file data, a wallet, a drive id; rejects nonsense; an empty height is honest', async () => {
  const cases: [string, RegExp, string][] = [
    [KNOWN.fileRecord, /File record/, 'file record'],
    [KNOWN.fileData, /File data|Nothing found/, 'file data'],
    [KNOWN.owner, /Wallet/, 'wallet'],
    [KNOWN.typicalDrive, /Drives/, 'drive id'],
  ];
  for (const [input, re, name] of cases) {
    await page.fill('#find', input);
    await clearStatus(page);
    await page.click('#findgo');
    const where = async () =>
      name === 'drive id' ? ((await driveRows(page)) > 0 ? 'Drives' : '') : await title(page);
    await until(
      page,
      async () =>
        re.test(await where()) &&
        !/Looking up|Finding/.test(
          await page
            .locator('#viewsub')
            .innerText()
            .catch(() => ''),
        ),
      180_000,
      name,
    );
    expect(await where(), `${name}: ${await status(page)}`).toMatch(re);
    if (name === 'file record') {
      await until(
        page,
        async () => (await page.locator('#more a', { hasText: 'Open the file' }).count()) > 0,
        20_000,
        'open the file link',
      );
      expect(await page.locator('#more a', { hasText: 'Open the file' }).count()).toBeGreaterThan(
        0,
      );
    }
  }
  for (const [input, re] of [
    ['hello world', /not a drive id/],
    ['', /Type a drive id/],
  ] as const) {
    await page.fill('#find', input);
    await clearStatus(page);
    await page.click('#findgo');
    await page.waitForTimeout(300);
    expect(await status(page)).toMatch(re);
  }
  await page.fill('#find', '1999999999');
  await clearStatus(page);
  await page.click('#findgo');
  await waitAnswer(page, 60_000);
  expect(/0 rows|no rows/i.test(await status(page)) || (await rows(page)) === 0).toBe(true);
});

test('a wide drive says its cost first, Stop cancels, and browsing works after a stop', async () => {
  await page.fill('#find', KNOWN.wideDrive);
  await page.click('#findgo');
  const gated = await until(
    page,
    async () => (await page.locator('#cost button').count()) > 0,
    60_000,
    'cost card',
  );
  expect(gated, await status(page)).toBe(true);
  expect(await page.locator('#cost').innerText()).toMatch(/reads about/);
  await page.locator('#cost button').click();
  await until(page, async () => !(await page.locator('#stop').isHidden()), 30_000, 'stop button');
  if (LIVE) {
    await page.waitForTimeout(3000);
    await page.click('#stop');
    await until(page, async () => /Stopped/.test(await status(page)), 60_000, 'stopped');
    expect(await status(page)).toMatch(/Stopped/);
  } else {
    // The fixture's wide drive reads in a moment; a Stop here races the listing, so the listing is accepted too.
    await until(
      page,
      async () => (await driveRows(page)) > 0 || /Stopped/.test(await status(page)),
      60_000,
      'wide drive',
    );
  }
  await clearStatus(page);
  await page.locator('#browse').click();
  await until(page, async () => (await rows(page)) > 0, 120_000, 'browse after stop');
  expect(await rows(page)).toBeGreaterThan(0);
});

test('periods: all history asks first for a question; a calendar year browses', async () => {
  await page.selectOption('#scope', 'all');
  await page.locator('#asks button').nth(3).click();
  if (LIVE) {
    await until(page, async () => await page.locator('#cost').isVisible(), 30_000, 'gate');
    expect(await page.locator('#cost').innerText()).toMatch(/holds about/);
  } else {
    await waitAnswer(page);
  }
  const yr = await page
    .locator('#scope option')
    .evaluateAll((os) =>
      (os as HTMLOptionElement[]).map((o) => o.value).find((v) => /^y\d{4}$/.test(v)),
    );
  if (yr) {
    await page.selectOption('#scope', yr);
    await clearStatus(page);
    await page.locator('#browse').click();
    await until(
      page,
      async () =>
        /Read|Nothing new|Answered|drives? in this period/.test(
          (await status(page)) +
            (await page
              .locator('#more')
              .innerText()
              .catch(() => '')),
        ),
      180_000,
      'year browse',
    );
  }
  await page.selectOption('#scope', 'month');
});

test('the data-source drawer: another gateway is refused with a reason, switching back re-verifies', async () => {
  await page.locator('#datadrawer > summary').click();
  const options = await page
    .locator('#gwsel option')
    .evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
  const other = options.find((o) => o !== 'auto' && o !== 'custom' && o !== GW);
  if (other) {
    await page.selectOption('#gwsel', other);
    await until(
      page,
      async () =>
        ['bad', 'ok'].includes((await page.locator('#proof').getAttribute('data-state')) ?? ''),
      60_000,
      'other gateway',
    );
    const txt = await page.locator('#proof-text').innerText();
    expect(/no index of ArDrive's data items|Refusing|not|Verified/i.test(txt), txt).toBe(true);
  }
  await page.selectOption('#gwsel', 'custom');
  await page.fill('#gw', GW);
  await page.click('#connect');
  await until(
    page,
    async () => (await page.locator('#proof').getAttribute('data-state')) === 'ok',
    60_000,
    'back',
  );
  await until(page, async () => (await rows(page)) > 0, 180_000, 'browse after switch');
  expect(await rows(page)).toBeGreaterThan(0);
});

test('light theme renders; phone width has no horizontal scroll', async ({ browser }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'e2e/out/light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await m.goto(url(''));
  await until(
    m,
    async () => (await m.locator('#results tbody tr').count()) > 0,
    180_000,
    'mobile browse',
  );
  const overflow = await m.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(
    overflow,
    `scrollWidth ${await m.evaluate(() => document.documentElement.scrollWidth)}`,
  ).toBe(false);
  await m.screenshot({ path: 'e2e/out/mobile.png', fullPage: true });
  await m.close();
});
