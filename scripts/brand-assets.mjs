#!/usr/bin/env node
/**
 * The pages' social cards and icons, rendered from the official brand files
 * in packages/ui/src/brand (copied unchanged from ar.io/brand-kit and
 * ArDrive's brand kit) into each app's public/ folder, so every build ships
 * its own: `social.png` (1200x630, the og/twitter image), `favicon.svg`
 * (and `favicon-dark.svg` where the brand has a light variant),
 * `favicon-32.png`, and `apple-touch-icon.png` (180x180).
 *
 *   WAVEHAUS_DIR=~/fonts/wavehaus node scripts/brand-assets.mjs [app ...]
 *
 * With app names, only those apps' files are written.
 *
 * ArDrive's card is set in Wavehaus, which may not be redistributed, so it
 * is not in this repository: point WAVEHAUS_DIR at a folder holding
 * Wavehaus-158ExtraBold.woff2 and Wavehaus-66Book.woff2 from ArDrive's brand
 * kit. Without it the card falls back to Plus Jakarta Sans, and says so.
 *
 * The outputs are committed: a build never runs a browser. Change a card's
 * words here, run this, and commit what it wrote. Claims on a card are the
 * ones the page's own description makes; no em dashes (ar.io brand kit).
 */
import { chromium } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.join(ROOT, 'packages/ui/src/brand');
const FONTS = path.join(ROOT, 'packages/ui/src/fonts');
const url = (p) => pathToFileURL(p).href;
const svg = (name) => readFileSync(path.join(BRAND, name), 'utf8');

const ARIO_FONTS = `
  @font-face { font-family: Besley; font-weight: 400 900; font-style: normal; src: url(${url(path.join(FONTS, 'besley-normal-latin.woff2'))}); }
  @font-face { font-family: Besley; font-weight: 400 900; font-style: italic; src: url(${url(path.join(FONTS, 'besley-italic-latin.woff2'))}); }
  @font-face { font-family: 'Plus Jakarta Sans'; font-weight: 200 800; src: url(${url(path.join(FONTS, 'plus-jakarta-sans-normal-latin.woff2'))}); }`;
const WAVEHAUS = process.env.WAVEHAUS_DIR;
if (!WAVEHAUS)
  console.warn('WAVEHAUS_DIR is not set: the ArDrive card is set in Plus Jakarta Sans');
const ARDRIVE_FONTS = WAVEHAUS
  ? `
  @font-face { font-family: Wavehaus; font-weight: 800; src: url(${url(path.join(WAVEHAUS, 'Wavehaus-158ExtraBold.woff2'))}); }
  @font-face { font-family: Wavehaus; font-weight: 400; src: url(${url(path.join(WAVEHAUS, 'Wavehaus-66Book.woff2'))}); }`
  : `
  @font-face { font-family: 'Plus Jakarta Sans'; font-weight: 200 800; src: url(${url(path.join(FONTS, 'plus-jakarta-sans-normal-latin.woff2'))}); }`;

/** ar.io: Deep Dark, a purple glow, Besley 800 with the emphasis in Dark Accent Lavender. */
const arioCard = ({
  eyebrow,
  title,
  em,
  sub,
  stats,
  host,
  size = 76,
}) => `<!doctype html><html><head><style>
  ${ARIO_FONTS}
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #0e0a1c; color: #fff; font-family: 'Plus Jakarta Sans'; overflow: hidden; position: relative; }
  .glow { position: absolute; inset: 0; background: radial-gradient(60% 70% at 85% 0%, rgba(84,39,200,.55) 0%, rgba(14,10,28,0) 70%); }
  .wrap { position: absolute; inset: 64px 72px 60px; display: flex; flex-direction: column; }
  .logo { height: 34px; }
  .logo svg { height: 34px; width: auto; }
  .eyebrow { margin-top: 52px; font-size: 17px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: #d4c6ff; }
  h1 { margin-top: 18px; font-family: Besley; font-weight: 800; font-size: ${size}px; line-height: 1.02; letter-spacing: -.025em; }
  h1 em { display: block; font-style: italic; color: #d4c6ff; }
  .sub { margin-top: 22px; font-size: 25px; line-height: 1.45; color: rgba(255,255,255,.7); max-width: 820px; }
  .foot { margin-top: auto; padding-top: 26px; border-top: 1px solid rgba(255,255,255,.12); display: flex; align-items: flex-end; gap: 64px; }
  .stat b { display: block; font-family: Besley; font-weight: 800; font-size: 44px; line-height: 1; }
  .stat span { display: block; margin-top: 10px; font-size: 14px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: #d4c6ff; }
  .host { margin-left: auto; font-size: 22px; font-weight: 600; color: rgba(255,255,255,.8); }
</style></head><body><div class="glow"></div><div class="wrap">
  <div class="logo">${svg('ario-full-white.svg')}</div>
  <div class="eyebrow">${eyebrow}</div>
  <h1>${title}<em>${em}</em></h1>
  ${sub ? `<p class="sub">${sub}</p>` : ''}
  <div class="foot">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}<div class="host">${host}</div></div>
</div></body></html>`;

/** ArDrive: Onyx, a Ruddy glow, Wavehaus (see WAVEHAUS_DIR), the emphasis in Primary red. */
const ardriveCard = ({ eyebrow, title, em, sub, host }) => `<!doctype html><html><head><style>
  ${ARDRIVE_FONTS}
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #121212; color: #fafafa; font-family: Wavehaus, 'Plus Jakarta Sans'; overflow: hidden; position: relative; }
  .glow { position: absolute; inset: 0; background: radial-gradient(55% 65% at 88% 0%, rgba(254,2,48,.28) 0%, rgba(18,18,18,0) 70%); }
  .wrap { position: absolute; inset: 64px 72px 60px; display: flex; flex-direction: column; }
  .logo img { height: 46px; width: auto; display: block; }
  .eyebrow { margin-top: 50px; font-size: 20px; font-weight: 400; color: rgba(250,250,250,.7); }
  h1 { margin-top: 16px; font-weight: 800; font-size: 78px; line-height: 1.02; letter-spacing: -.02em; }
  h1 em { display: block; font-style: normal; color: #d31721; }
  .sub { margin-top: 24px; font-weight: 400; font-size: 26px; line-height: 1.4; color: rgba(250,250,250,.7); max-width: 860px; }
  .foot { margin-top: auto; padding-top: 26px; border-top: 1px solid rgba(250,250,250,.12); display: flex; align-items: center; }
  .foot span { font-size: 18px; color: rgba(250,250,250,.6); }
  .host { margin-left: auto; font-size: 22px; font-weight: 400; color: rgba(250,250,250,.85); }
</style></head><body><div class="glow"></div><div class="wrap">
  <div class="logo"><img src="${url(path.join(BRAND, 'ardrive-wordmark-on-dark.svg'))}" alt=""></div>
  <div class="eyebrow">${eyebrow}</div>
  <h1>${title}<em>${em}</em></h1>
  <p class="sub">${sub}</p>
  <div class="foot"><span>Indexed by ar.io gateways</span><div class="host">${host}</div></div>
</div></body></html>`;

/** An icon on a square plate, for the PNG sizes. */
const plate = (inner, bg) => `<!doctype html><html><head><style>
  * { margin: 0; } html, body { width: 100%; height: 100%; background: ${bg}; }
  body { display: flex; align-items: center; justify-content: center; }
  .i { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .i > svg, .i > img { width: 100%; height: 100%; object-fit: contain; }
</style></head><body><div class="i">${inner}</div></body></html>`;

const APPS = {
  'network-index': {
    card: arioCard({
      eyebrow: 'CDB64 root transaction index',
      title: 'Which transaction holds',
      em: 'this data item?',
      sub: '',
      stats: [
        ['3.84B', 'Data items indexed'],
        ['516.7 GB', 'Index size'],
        ['180', 'Arweave transactions'],
      ],
      host: 'cdb64.ar.io',
    }),
    icons: 'ario',
  },
  'arweave-l1-explorer': {
    card: arioCard({
      eyebrow: 'Arweave L1 index explorer',
      title: 'Query Arweave’s base layer.',
      em: 'Verify every byte.',
      sub: 'Find any transaction, wallet or app in seconds. SQL in your browser, every byte checked.',
      stats: [
        ['80M+', 'Transactions'],
        ['2M+', 'Blocks'],
        ['2018 to 2026', 'Covering'],
      ],
      host: 'arweave-l1-search.ar.io',
      size: 64,
    }),
    icons: 'ario',
  },
  'ardrive-explorer': {
    card: ardriveCard({
      eyebrow: 'ArDrive Explorer',
      title: 'Every public drive,',
      em: 'folder and file.',
      sub: 'Browse ArDrive, or query all of it with SQL in your browser, against a gateway-signed index verified byte by byte.',
      host: 'explore_ardrive.ar.io',
    }),
    icons: 'ardrive',
  },
};

const tmp = mkdtempSync(path.join(tmpdir(), 'brand-'));
const browser = await chromium.launch();
async function shoot(html, out, width, height, clear = false) {
  const file = path.join(tmp, `${path.basename(out)}.html`);
  writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url(file));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: clear });
  await page.close();
}

const only = process.argv.slice(2);
for (const [app, a] of Object.entries(APPS)) {
  if (only.length && !only.includes(app)) continue;
  const pub = path.join(ROOT, 'apps', app, 'public');
  mkdirSync(pub, { recursive: true });
  await shoot(a.card, path.join(pub, 'social.png'), 1200, 630);
  if (a.icons === 'ario') {
    // The icon, dark on light tabs and light on dark ones, as the kit says.
    copyFileSync(path.join(BRAND, 'ario-black.svg'), path.join(pub, 'favicon.svg'));
    copyFileSync(path.join(BRAND, 'ario-white.svg'), path.join(pub, 'favicon-dark.svg'));
    const square = svg('ario-white-on-black-square.svg');
    await shoot(plate(square, '#23232d'), path.join(pub, 'apple-touch-icon.png'), 180, 180);
    await shoot(plate(square, '#23232d'), path.join(pub, 'favicon-32.png'), 32, 32);
  } else {
    // The kit's icon, its artwork unchanged: only the canvas is cropped to the
    // mark (its 150 px square leaves wide margins), so in a tab it fills the
    // square as ardrive.io's own favicon does, on any tab colour.
    const icon = svg('ardrive-icon.svg').replace(
      'width="150" height="150" viewBox="0 0 150 150"',
      'width="32" height="32" viewBox="27 24 103 103"',
    );
    if (!icon.includes('viewBox="27 24 103 103"')) throw new Error('ardrive-icon.svg changed');
    writeFileSync(path.join(pub, 'favicon.svg'), icon);
    await shoot(plate(icon, 'transparent'), path.join(pub, 'favicon-32.png'), 32, 32, true);
    // A home-screen icon needs a plate: the kit's icon on its dark plate.
    const onyx = `<img src="${url(path.join(BRAND, 'ardrive-icon-onyx.png'))}">`;
    await shoot(plate(onyx, '#121212'), path.join(pub, 'apple-touch-icon.png'), 180, 180);
  }
  console.log(`${app}: social.png, favicons, apple-touch-icon.png`);
}
await browser.close();
