/**
 * The masthead's counts stay in their columns at every width: each value's
 * text, at its longest (twelve digits), ends before the next column begins,
 * and the page never scrolls sideways. Shared by all three pages
 * (`packages/ui`'s `.stats`), so each is checked. The values are written in
 * place, in the same task as the measurement, so no data is needed.
 */
import { expect, test } from '@playwright/test';

const PAGES = [
  { app: 'ardrive-explorer', env: 'LIVE_BASE', mount: '/' },
  { app: 'arweave-l1-explorer', env: 'L1_BASE', mount: '/l1/' },
  { app: 'network-index', env: 'NI_BASE', mount: '/network-index/' },
];
const deployed = PAGES.some((p) => process.env[p.env]);
const LONG = ['999,999,999,999', '999,999,999,999', '999,999,999,999', '2021–2026'];

for (const p of PAGES) {
  test(`${p.app}: the counts stay in their columns from 320 to 1400 px`, async ({ page }) => {
    test.skip(deployed && !process.env[p.env], 'another page was deployed');
    await page.goto(process.env[p.env] || p.mount, { waitUntil: 'domcontentloaded' });
    await page.locator('#stats').waitFor();
    const bad: string[] = [];
    for (let w = 320; w <= 1400; w += 20) {
      await page.setViewportSize({ width: w, height: 900 });
      const found = await page.evaluate((long) => {
        const out: string[] = [];
        const stats = [...document.querySelectorAll('#stats .stat')] as HTMLElement[];
        stats.forEach((s, i) => {
          const dd = s.querySelector('dd');
          if (dd) dd.textContent = long[i % long.length]!;
        });
        stats.forEach((s, i) => {
          const dd = s.querySelector('dd');
          if (!dd) return;
          const r = document.createRange();
          r.selectNodeContents(dd);
          const text = r.getBoundingClientRect();
          const box = s.getBoundingClientRect();
          if (text.right > box.right + 0.5) out.push(`value ${i + 1} overflows its column`);
          const next = stats[i + 1]?.getBoundingClientRect();
          if (next && Math.abs(next.top - box.top) < 1 && text.right > next.left + 0.5)
            out.push(`value ${i + 1} runs into value ${i + 2}`);
        });
        if (document.documentElement.scrollWidth > window.innerWidth)
          out.push('the page scrolls sideways');
        return out;
      }, LONG);
      for (const f of found) bad.push(`${w} px: ${f}`);
    }
    expect(bad).toEqual([]);
  });
}
