/**
 * The L1 explorer on the client: the publication verifies, a question answers
 * over the period with a receipt, a block height and a wallet are found through
 * the lookups, and a preset runs. Served from the fixture gateway as
 * /l1/ (dist-e2e of apps/arweave-l1-explorer) and against turbo-gateway.com live.
 */
import { expect, test } from '@playwright/test';

import { GW, LIVE, until } from './helpers.js';

const BASE = process.env.L1_BASE || (LIVE ? '/l1/' : '/l1/');

test.describe('arweave-l1-explorer', () => {
  test('verifies, answers a question, finds a block and a wallet, runs a preset', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}#gw=${encodeURIComponent(GW)}&scope=latest`);
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
    expect(await page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true);
    // The editor opens with the first example, so Run answers at once.
    expect(await page.inputValue('#sql')).toMatch(/^SELECT height, count\(\*\) AS txs/);
    const status = () =>
      page
        .locator('#status')
        .innerText()
        .catch(() => '');
    const rows = () => page.locator('#results tbody tr').count();
    // The status line still holds the last answer until the next one replaces
    // it, so clear it through the store before each action; otherwise
    // answered() can match the previous answer and count a table mid-redraw.
    const clear = () =>
      page.evaluate(() =>
        (
          window as unknown as { __explorer: { store: { say(t: string): void } } }
        ).__explorer.store.say(''),
      );
    // An answer is its receipt (case matters: a period load says "Questions
    // read only what they need") with nothing left running.
    const answered = () =>
      until(
        page,
        async () => {
          const s = await status();
          return (
            (/rows? in|Read |Nothing new|Answered/.test(s) ||
              /error|could not/i.test(s) ||
              (await page.locator('#status .bad').count()) > 0) &&
            !(await page.evaluate(
              () =>
                (window as unknown as { __explorer: { store: { working: { value: boolean } } } })
                  .__explorer.store.working.value,
            ))
          );
        },
        LIVE ? 300_000 : 120_000,
        'answer',
      );
    // A question: apps writing to Arweave, from the tag lookup.
    await clear();
    await page.locator('#asks button').nth(0).click();
    await answered();
    expect(await status()).not.toMatch(/error|could not/i);
    expect(await page.locator('#status .bad').count()).toBe(0);
    expect(await rows()).toBeGreaterThan(0);
    expect(await page.locator('#caption').innerText()).toMatch(/Apps that sent transactions/);
    // A preset, while the period is still the last few days: a Find below
    // moves it to all of history, where this preset groups every block
    // (about 550 MB live, which the page warns of before it reads).
    await page.locator('#editor > summary').click();
    await page.locator('#presets button', { hasText: 'Busiest blocks' }).click();
    await clear();
    await page.click('#run');
    await answered();
    expect(await rows()).toBeGreaterThan(0);
    // An empty editor says so rather than doing nothing.
    const kept = await page.inputValue('#sql');
    await page.fill('#sql', '');
    await clear();
    await page.click('#run');
    expect(await status()).toMatch(/Write a query/);
    await page.fill('#sql', kept);
    // Exports and the share link.
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.click('#csv'),
    ]);
    expect(await dl.suggestedFilename()).toMatch(/^arweave-l1-.*\.csv$/);
    await page.click('#copylink');
    expect(await page.evaluate(() => location.hash)).toMatch(/sql=/);
    // A block height.
    const tip = await page.evaluate(() => {
      const s = (
        window as unknown as { __explorer: { session: { bands: { to: number | null }[] } } }
      ).__explorer.session;
      return s.bands[s.bands.length - 1]!.to;
    });
    await page.fill('#find', String(tip));
    await clear();
    await page.click('#findgo');
    await answered();
    expect(await page.locator('#answertitle').innerText()).toMatch(/Block/);
    // A wallet, taken from the first row's owner column, through the lookups.
    const owner = await page.evaluate(() => {
      const r = (
        window as unknown as {
          __explorer: {
            store: {
              result: { value: { rows: Record<string, unknown>[]; cols: string[] } | null };
            };
          };
        }
      ).__explorer.store.result.value;
      return r && r.cols.includes('owner') && r.rows[0] ? String(r.rows[0].owner) : null;
    });
    if (owner) {
      await page.fill('#find', owner);
      await clear();
      await page.click('#findgo');
      await answered();
      expect(await page.locator('#answertitle').innerText()).toMatch(/Wallet/);
      expect(await rows()).toBe(1);
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'e2e/out/l1.png', fullPage: true });
  });
  test('Find brings its answer into view, and says what it searched for a block outside the index', async ({
    browser,
  }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${BASE}#gw=${encodeURIComponent(GW)}&scope=latest`);
    await until(
      page,
      async () => (await page.locator('#proof').getAttribute('data-state')) === 'ok',
      90_000,
      'proof',
    );
    type L1 = {
      __explorer: {
        session: {
          bands: { from: number; to: number | null }[];
          currentWindow(): unknown;
          windowHeights(w: unknown): [number, number];
        };
        store: { working: { value: boolean }; say(t: string): void };
      };
    };
    const status = () =>
      page
        .locator('#status')
        .innerText()
        .catch(() => '');
    const inView = (sel: string) =>
      page.evaluate((q) => {
        const r = document.querySelector(q)!.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }, sel);
    const find = async (text: string) => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => (window as unknown as L1).__explorer.store.say(''));
      await page.fill('#find', text);
      await page.press('#find', 'Enter');
    };
    const done = (what: string) =>
      until(
        page,
        async () =>
          !!(await status()) &&
          !/^Asking|^Reading|^Loading/.test(await status()) &&
          !(await page.evaluate(() => (window as unknown as L1).__explorer.store.working.value)),
        120_000,
        what,
      );
    // A refusal: the error line comes into view.
    await find('nonsense text');
    await done('refusal');
    await page.waitForTimeout(900);
    expect(await status()).toMatch(/is not a block height/);
    expect(await inView('#status'), 'the error line').toBe(true);
    const { first, tip, lo } = await page.evaluate(() => {
      const s = (window as unknown as L1).__explorer.session;
      return {
        first: s.bands[0]!.from,
        tip: s.bands[s.bands.length - 1]!.to ?? 0,
        lo: s.windowHeights(s.currentWindow())[0],
      };
    });
    // Newer than the index: said, not "0 rows".
    await find(String(tip + 1000));
    await done('past the tip');
    expect(await status()).toMatch(/newer than this index, which reaches block/);
    // Older than the index: said too. (The fixture's one band is the whole
    // period, so a block in the index but outside the period cannot be made here.)
    expect(first).toBe(lo);
    await find(String(first - 10));
    await done('before the index');
    expect(await status()).toMatch(/older than this index, which starts at block/);
    // A block in the period: its answer in view, said in words when empty.
    await find(String(first));
    await done('a block');
    await page.waitForTimeout(900);
    expect(await page.locator('#answertitle').innerText()).toMatch(/^Block /);
    expect(await status()).toMatch(/rows? in|No transactions in block/);
    expect(await status()).not.toMatch(/^0 rows/);
    expect(await inView('#answertitle'), 'the answer title').toBe(true);
    // Asked again with the answer on screen: the page stays where it is.
    const y = await page.evaluate(() => window.scrollY);
    await page.press('#find', 'Enter');
    await done('again');
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
    await page.close();
  });
});
