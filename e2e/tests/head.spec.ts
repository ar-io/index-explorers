/**
 * Every page's icons and social card ship with it and resolve: each icon
 * link answers with an image, og:image and twitter:image name the page's own
 * `social.png` on its own name, and the copy in the build is a 1200x630 PNG.
 * On the fixture gateway all three pages are checked; after a deploy, only
 * the one whose URL the Deploy workflow passes (LIVE_BASE, L1_BASE, NI_BASE).
 */
import { expect, test } from '@playwright/test';

const PAGES = [
  { app: 'ardrive-explorer', env: 'LIVE_BASE', mount: '/', name: 'https://explore_ardrive.ar.io' },
  {
    app: 'arweave-l1-explorer',
    env: 'L1_BASE',
    mount: '/l1/',
    name: 'https://arweave-l1-search.ar.io',
  },
  { app: 'network-index', env: 'NI_BASE', mount: '/network-index/', name: 'https://cdb64.ar.io' },
];
const deployed = PAGES.some((p) => process.env[p.env]);

for (const p of PAGES) {
  test(`${p.app}: icons and social card resolve`, async ({ page }) => {
    test.skip(deployed && !process.env[p.env], 'another page was deployed');
    const base = process.env[p.env] || p.mount;
    // The head only: no need to wait for the publication to verify.
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const head = await page.evaluate(() => ({
      icons: [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map(
        (l) => (l as HTMLLinkElement).href,
      ),
      og: document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '',
      tw: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ?? '',
      card: document.querySelector('meta[name="twitter:card"]')?.getAttribute('content') ?? '',
    }));
    expect(head.icons.length).toBeGreaterThan(0);
    for (const href of head.icons) {
      expect(href, 'icons ship with the page, not as data: URIs').not.toMatch(/^data:/);
      const r = await page.request.get(href);
      expect(r.status(), href).toBe(200);
      expect(r.headers()['content-type'], href).toMatch(/^image\//);
    }
    expect(head.og).toBe(`${p.name}/social.png`);
    expect(head.tw).toBe(head.og);
    expect(head.card).toBe('summary_large_image');
    const card = await page.request.get(new URL('social.png', page.url()).href);
    expect(card.status()).toBe(200);
    const png = await card.body();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
}
