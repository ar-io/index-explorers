import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.join(ROOT, 'fixtures');
export const LIVE = path.join(FIXTURES, 'live');

export const readBytes = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
export const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

export const LIVE_PUBLICATION = path.join(LIVE, 'publication-turbo-gateway-seq159.json');
export const LIVE_PEERS = path.join(LIVE, 'peers-vilenarios.json');
export const LIVE_BAND_ID = 'l2-h700000-799999-3078e8b8-a2a34f51df49';
export const LIVE_BAND_DIR = path.join(LIVE, 'ardrive-l2', LIVE_BAND_ID);
export const LIVE_TORRENT = path.join(
  LIVE,
  'torrents',
  '43f7de78570542926d82e9e37c45b014409c14f1.torrent',
);
export const LIVE_TORRENT_IH2 = 'fe8c79aebba7ff9b92bd75133e51084b198f982f7d0d11bf922abc10b6a7f49c';
export const PUBLISHER = '34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5';
export const GATEWAY = 'https://turbo-gateway.com';

/** A fetch that serves fixed bodies by URL and 404 for anything else. */
export function fakeFetch(
  routes: Record<string, string | Uint8Array | (() => Response)>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const hit = routes[url];
    if (hit === undefined) return new Response('not found', { status: 404 });
    if (typeof hit === 'function') return hit();
    return new Response(hit as BodyInit, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
