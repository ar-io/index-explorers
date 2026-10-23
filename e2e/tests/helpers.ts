import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LIVE = !!process.env.LIVE;
const PORT = Number(process.env.FIXTURE_PORT || 8787);

/** The data gateway the page is told to read. */
export const GW = LIVE ? process.env.GW || 'https://turbo-gateway.com' : `http://localhost:${PORT}`;

export interface Known {
  bigDrive: string;
  typicalDrive: string;
  wideDrive: string;
  privateDrive: string;
  owner: string;
  fileRecord: string;
  fileData: string;
  folder: string;
  deepFolder: string;
  tip: number;
}

/** The ids each suite exercises: the synthetic fixture's, or the live drives V1-ARCHITECTURE.md names. */
export const KNOWN: Known = LIVE
  ? {
      bigDrive: 'b76a5542-40c4-415c-8796-365d8dc365c7',
      typicalDrive: '05b211dd-ae1e-44ef-b055-2e102933e4e8',
      wideDrive: 'edef3743-16ad-4488-b4f7-f3710d21af7f',
      privateDrive: '',
      owner: 'dBRMGwLFzqr7V6CSNU6ZwcrDfDI20Y1vdZfpBQINbNU',
      fileRecord: '4aCplvNxtUx2DnpUUhhGkecFXiUDJFYhZDlra8ClGXA',
      fileData: 'w_jCw81j3dfFhlcOYlFRcUw8U4uMBD8Ho_nx8Vzw8hc',
      folder: '',
      deepFolder: '',
      tip: 0,
    }
  : (JSON.parse(readFileSync(path.join(ROOT, 'fixtures/synthetic/known.json'), 'utf8')) as Known);

export const url = (frag: string): string =>
  `#gw=${encodeURIComponent(GW)}&period=month${frag ? '&' + frag : ''}`;

export const status = (page: Page) =>
  page
    .locator('#status')
    .innerText()
    .catch(() => '');
export const title = (page: Page) =>
  page
    .locator('#viewtitle')
    .innerText()
    .catch(() => '');
export const rows = (page: Page) => page.locator('#results tbody tr').count();
export const driveRows = (page: Page) => page.locator('#b-list tbody tr.b-row').count();
/**
 * A drive has opened: it lists rows, asks about its cost first, or (a drive
 * that holds no files yet) its records are read and its root says it is empty.
 */
export const driveOpened = async (page: Page) =>
  (await driveRows(page)) > 0 ||
  (await page.locator('#cost').isVisible()) ||
  ((await page.locator('#b-empty').isVisible()) &&
    /records? between blocks/.test((await page.locator('#b-sub').textContent()) ?? ''));

/** Polls until `fn` is true, logging the status on a timeout. */
export async function until(
  page: Page,
  fn: () => Promise<boolean>,
  ms: number,
  what: string,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(250);
  }
  console.log('TIMEOUT', what, '| status:', await status(page));
  return false;
}

/** Clears the status line through the store: the DOM belongs to the renderer. */
export const clearStatus = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __explorer: { store: { say(t: string): void } } }).__explorer.store.say(
      '',
    ),
  );

/** Waits for a listing or query to answer (a receipt, a row count, an error, or a cost card). */
export const waitAnswer = (page: Page, ms = LIVE ? 240_000 : 60_000) =>
  until(
    page,
    async () =>
      /rows? in|Read |Nothing new|Answered from/.test(await status(page)) ||
      /error|could not|bad/i.test(await status(page)) ||
      (await page.locator('#cost').isVisible()),
    ms,
    'answer',
  );

export async function openPage(page: Page, frag = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(String(e));
    console.log('pageerror', String(e).slice(0, 300));
  });
  await page.goto(url(frag));
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
  (page as unknown as { __errors: string[] }).__errors = errors;
}

export const pageErrors = (page: Page): string[] =>
  (page as unknown as { __errors?: string[] }).__errors ?? [];

/**
 * Clicks the n-th folder row and measures, inside the page, from the click to
 * the first paint after the breadcrumbs changed: the folder move as a reader
 * feels it, without the test runner's round trips.
 */
export const openFolderMeasured = (page: Page, nth: number): Promise<number> =>
  page.evaluate(async (idx) => {
    const rows = [...document.querySelectorAll('#b-list tbody tr.b-row')].filter((r) =>
      r.querySelector('.ico-folder'),
    ) as HTMLElement[];
    const before = document.querySelectorAll('#b-crumbs .crumb').length;
    const t = performance.now();
    rows[idx]!.click();
    while (
      document.querySelectorAll('#b-crumbs .crumb').length === before &&
      performance.now() - t < 5000
    )
      await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    return performance.now() - t;
  }, nth);
