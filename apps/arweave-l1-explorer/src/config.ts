import { KNOWN_PUBLISHERS, REGISTRY_GATEWAYS } from '@ar-io/index-client';

import lock from '../../../engine.lock.json';

const env = import.meta.env as Record<string, string | undefined>;
const list = (v: string | undefined): string[] | null =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

export const CONFIG = {
  indexName: 'parquet-l1',
  engineHosts: list(env.VITE_ENGINE_HOSTS) ?? lock.hosts,
  pins: { worker: lock.worker, wasm: lock.wasm, extension: lock.extension },
  registryGateways: list(env.VITE_REGISTRY_GATEWAYS) ?? REGISTRY_GATEWAYS,
  publishers: list(env.VITE_PUBLISHERS) ?? KNOWN_PUBLISHERS,
  /** The most a reader is asked to download whole (no range reader). */
  loadCap: 100e6,
  /** A whole history range of the band grid; anything shorter is a sub-range or the tip. */
  l1Span: 100000,
  portalUrl: 'https://gateways.ar.io',
} as const;
