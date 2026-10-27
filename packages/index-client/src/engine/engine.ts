/**
 * DuckDB-WASM, pinned by hash. The engine computes the answers: unverified
 * bytes here would be worse than unverified data. The worker and the wasm
 * are fetched from the first host whose bytes match the pinned SHA-256; the
 * Parquet extension is checked by DuckDB's own signature, which cannot be
 * switched off from the page.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { Table } from 'apache-arrow';

import { sha256Hex } from '../util/bytes.js';
import { fetchWithProgress, type ProgressReport } from '../util/fetch.js';

export interface PinnedFile {
  /** Path under an engine host. */
  path: string;
  /** SHA-256 of the decompressed bytes. */
  sha256: string;
  /** Decompressed size: a gateway may serve these gzipped, so Content-Length is not the total. */
  size: number;
}

export interface EnginePins {
  worker: PinnedFile;
  wasm: PinnedFile;
  extension: { path: string };
}

export interface EngineOptions {
  /** Base URLs (with trailing slash) the pinned files are fetched from, in order. */
  hosts: string[];
  pins: EnginePins;
  onStatus?: (msg: string) => void;
  onProgress?: (p: ProgressReport | { busy: string }) => void;
  fetch?: typeof fetch;
}

const joinUrl = (host: string, path: string) => host.replace(/\/+$/, '') + '/' + path;

/** From the first host whose bytes match the pinned hash; each failure moves on. */
export async function fetchVerified(
  hosts: string[],
  pin: PinnedFile,
  label: string,
  onProgress?: (p: ProgressReport | { busy: string }) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const why: string[] = [];
  for (const host of hosts) {
    try {
      const bytes = await fetchWithProgress(
        joinUrl(host, pin.path),
        label,
        pin.size,
        onProgress,
        fetchImpl,
      );
      onProgress?.({ busy: `Checking ${label} against its pinned SHA-256` });
      if ((await sha256Hex(bytes)) === pin.sha256) return bytes;
      why.push(`${host} sent bytes that do not match its pinned SHA-256`);
    } catch (e) {
      why.push(`${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`${label} could not be fetched intact from any gateway (${why.join('; ')})`);
}

export type { Table };

export class Engine {
  /** Whether the Parquet reader came from duckdb.org rather than Arweave (still signature-checked). */
  extFallback = false;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private files = new Map<string, { url: string; size: number }>();

  private constructor(
    private db: duckdb.AsyncDuckDB,
    private conn: duckdb.AsyncDuckDBConnection,
    private readonly opts: EngineOptions,
    /** The checked worker and wasm, kept so a restart needs no fetch and no new check. */
    private readonly urls: { worker: string; wasm: string },
  ) {}

  static async open(opts: EngineOptions): Promise<Engine> {
    const say = opts.onStatus ?? (() => {});
    say('Fetching the DuckDB worker from Arweave and checking its hash');
    const workerBytes = await fetchVerified(
      opts.hosts,
      opts.pins.worker,
      'the DuckDB worker',
      opts.onProgress,
      opts.fetch,
    );
    const workerUrl = URL.createObjectURL(
      new Blob([workerBytes as BlobPart], { type: 'text/javascript' }),
    );
    say('Fetching the DuckDB engine from Arweave, once per visit');
    const wasmBytes = await fetchVerified(
      opts.hosts,
      opts.pins.wasm,
      'the DuckDB engine',
      opts.onProgress,
      opts.fetch,
    );
    const wasmUrl = URL.createObjectURL(
      new Blob([wasmBytes as BlobPart], { type: 'application/wasm' }),
    );
    say('Starting the engine');
    opts.onProgress?.({ busy: 'Starting the engine' });
    const urls = { worker: workerUrl, wasm: wasmUrl };
    const { db, conn } = await Engine.start(urls);
    const engine = new Engine(db, conn, opts, urls);
    await engine.configure(conn);
    await engine.loadExtension(conn);
    return engine;
  }

  private static async start(urls: {
    worker: string;
    wasm: string;
  }): Promise<{ db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }> {
    // VoidLogger: ConsoleLogger writes a line to the console for every query.
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(urls.worker));
    await db.instantiate(urls.wasm);
    // Range reads: a HEAD for the size, then ranged GETs, never a whole file.
    // forceFullHTTPReads must be said: left unset, the engine falls back to
    // whole-file reads.
    await db.open({
      filesystem: {
        reliableHeadRequests: true,
        allowFullHTTPReads: false,
        forceFullHTTPReads: false,
      },
    });
    return { db, conn: await db.connect() };
  }

  /** The Parquet reader, from Arweave's copies first. */
  private async loadExtension(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
    for (const host of this.opts.hosts) {
      try {
        await conn.query(`LOAD '${joinUrl(host, this.opts.pins.extension.path)}'`);
        return;
      } catch {
        /* next */
      }
    }
    // Arweave's copies unreachable: let DuckDB fetch its own. Still checked
    // against DuckDB's signature, but a third party is now involved.
    await conn.query('SET autoinstall_known_extensions = true');
    await conn.query('SET autoload_known_extensions = true');
    this.extFallback = true;
  }

  /** Session settings, applied to every connection the engine opens. */
  private async configure(c: duckdb.AsyncDuckDBConnection): Promise<void> {
    // Each query would otherwise read every file's footer again.
    await c.query('SET parquet_metadata_cache = true');
    // DuckDB sizes a list of Parquet files from the first one, so over all
    // history it can build its join table from the big side: keeping the
    // written join order keeps the small side as the build side.
    try {
      await c.query("SET disabled_optimizers = 'build_side_probe_side'");
    } catch {
      /* older engine */
    }
    await c.query('SET autoinstall_known_extensions = false');
    await c.query('SET autoload_known_extensions = false');
  }

  /** Runs one statement. Queries are serialised on the one connection. */
  query(sql: string, opts: { signal?: AbortSignal } = {}): Promise<Table> {
    const run = async (): Promise<Table> => {
      if (opts.signal?.aborted) throw new Error('Stopped.');
      return (await this.conn.query(sql)) as unknown as Table;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Runs several statements in order; the result of the last. */
  async exec(statements: string[]): Promise<void> {
    for (const s of statements) await this.query(s);
  }

  /** A file name never used before: re-registering under an old name leaves stale Parquet metadata. */
  freshName(kind: string): string {
    this.seq += 1;
    return `r${this.seq}_${kind}.parquet`;
  }

  /** `size`, when known, lets a read ahead fetch the file's footer before DuckDB asks. */
  async registerUrl(name: string, url: string, size?: number): Promise<void> {
    await this.db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
    if (size !== undefined) this.files.set(name, { url, size });
  }

  /** The URL and size a name was registered with. */
  fileOf(name: string): { url: string; size: number } | undefined {
    return this.files.get(name);
  }

  async registerBuffer(name: string, bytes: Uint8Array): Promise<void> {
    await this.db.registerFileBuffer(name, bytes);
  }

  async dropFile(name: string): Promise<void> {
    this.files.delete(name);
    try {
      await this.db.dropFile(name);
    } catch {
      /* already gone */
    }
  }

  /**
   * After the engine ran out of memory, neither its open files nor a fresh
   * connection can be trusted: the next read has failed in odd ways ("too
   * small to be a Parquet file"), because the worker's memory stays as full
   * as the failure left it. A new worker from the same checked bytes; every
   * registered file is gone, so the caller registers its bands again (the
   * checked pieces stay in the range reader).
   */
  async restart(): Promise<void> {
    try {
      await this.db.terminate();
    } catch {
      /* already gone */
    }
    const { db, conn } = await Engine.start(this.urls);
    this.db = db;
    this.conn = conn;
    this.files.clear();
    this.chain = Promise.resolve();
    await this.configure(conn);
    await this.loadExtension(conn);
  }

  async close(): Promise<void> {
    try {
      await this.conn.close();
    } catch {
      /* ignore */
    }
    await this.db.terminate();
  }

  get options(): EngineOptions {
    return this.opts;
  }
}

export const openEngine = (opts: EngineOptions): Promise<Engine> => Engine.open(opts);

/** Arrow rows are proxies: a spread loses fields and BigInt arithmetic throws in comparators. */
export function rowsOf<T = Record<string, unknown>>(table: Table): T[] {
  return table
    .toArray()
    .map((r) =>
      r && typeof (r as { toJSON?: unknown }).toJSON === 'function'
        ? (r as { toJSON(): T }).toJSON()
        : ({ ...r } as T),
    );
}

export const columnsOf = (table: Table): string[] => table.schema.fields.map((f) => f.name);

/** Columns Arrow hands back as epoch milliseconds. */
export const timeColumnsOf = (table: Table): Set<string> =>
  new Set(
    table.schema.fields.filter((f) => /Timestamp|Date/i.test(String(f.type))).map((f) => f.name),
  );
