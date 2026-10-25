/**
 * The page's constants. The ones a deterministic E2E run has to point at a
 * local fixture gateway come from build-time environment variables; the
 * defaults are the production values.
 */
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
const number = (v: string | undefined, def: number): number =>
  v && Number.isFinite(Number(v)) ? Number(v) : def;

export const CONFIG = {
  /** The index this page reads, as the publication names it. */
  indexName: 'ardrive-l2',
  engineHosts: list(env.VITE_ENGINE_HOSTS) ?? lock.hosts,
  pins: { worker: lock.worker, wasm: lock.wasm, extension: lock.extension },
  registryGateways: list(env.VITE_REGISTRY_GATEWAYS) ?? REGISTRY_GATEWAYS,
  publishers: list(env.VITE_PUBLISHERS) ?? KNOWN_PUBLISHERS,
  /** The most a listing reads without asking first. */
  askFirstBytes: number(env.VITE_ASK_FIRST_BYTES, 40e6),
  /** Periods larger than this ask before a question runs over them. */
  askFirstPeriod: number(env.VITE_ASK_FIRST_PERIOD, 400e6),
  /** The most a reader is asked to download whole (no range reader). */
  loadCap: 100e6,
  /** Rows a listing shows; exports carry them all. */
  page: 50,
  /** Windowed rendering: this many rows at a time. */
  renderChunk: 200,
  nameConcurrency: 6,
  /** Names fetched in the background for a drive, beyond what is on screen. */
  backgroundNames: 1500,
  /** The most records a drive listing reads. */
  listCap: 20000,
  /** A wide drive is read in slices of this many blocks. */
  slice: 5000,
  /** Owner-narrowing clusters: a gap wider than this starts a new stretch. */
  clusterGap: 250,
  /** Wallet view: stretches read at first, and at most on request. */
  walletRecent: 3,
  walletMax: 400,
  walletRows: 50000,
  /** Where files open. */
  appUrl: 'https://app.ardrive.io',
  portalUrl: 'https://gateways.ar.io',
} as const;

export const APPS = [
  'ArDrive-App',
  'ArDrive-Web',
  'ArDrive-CLI',
  'ArDrive-Core',
  'ArDrive-Desktop',
  'ArDrive-Mobile',
  'ArDrive-Sync',
];
