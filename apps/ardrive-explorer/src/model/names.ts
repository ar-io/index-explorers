/**
 * Names: each record's small JSON, read from the gateway. Not covered by the
 * signature, so each is checked for size against the index's data_size for
 * that record, and a mismatch is reported, never hidden.
 *
 * One small pool: what is on screen first (a stack, so the newest request is
 * served first), then the rest in order; a few at a time, because twenty
 * thousand parallel fetches would stall the page and the gateway alike. A
 * record that fails is retried once after a pause. Membership is a Set:
 * searching a queue per item is quadratic at twenty thousand.
 */
export interface NameResult {
  ok: boolean;
  name: string | null;
  meta: Record<string, unknown> | null;
  why: string | null;
}

export interface RecordFetch {
  /** Fetches `/raw/{id}`; resolves to the status and bytes, or throws on a network failure. */
  (id: string): Promise<{ status: number; bytes: Uint8Array }>;
}

export interface NamePoolOptions {
  fetchRecord: RecordFetch;
  concurrency?: number;
  retryAfterMs?: number;
  /** Called when a record lands (or fails for good). */
  onResult: (id: string, result: NameResult) => void;
}

interface Job {
  id: string;
  dataSize: number | null;
}

export class NamePool {
  readonly cache = new Map<string, NameResult>();
  private readonly front: Job[] = [];
  private readonly queue: Job[] = [];
  private readonly queued = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly inflight = new Set<string>();
  private active = 0;
  /** Jobs taken since the last reset, and jobs finished. */
  wanted = 0;
  loaded = 0;
  private generation = 0;

  constructor(private readonly opts: NamePoolOptions) {}

  get pending(): number {
    return this.wanted - this.loaded;
  }

  /** Forgets the queue (not the cache): a new drive starts clean. */
  reset(): void {
    this.front.length = 0;
    this.queue.length = 0;
    this.queued.clear();
    this.wanted = 0;
    this.loaded = 0;
    this.generation += 1;
  }

  /** Forgets everything: a new publication, whose records may differ. */
  clear(): void {
    this.reset();
    this.cache.clear();
    this.retried.clear();
  }

  /** The cached result, or null while it is still to come. `front` puts it ahead of everything queued. */
  want(id: string, dataSize: number | null, front: boolean): NameResult | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    if (this.queued.has(id) || this.inflight.has(id)) {
      if (front && !this.front.some((j) => j.id === id)) {
        // Promote: the back queue keeps its entry, which is skipped when reached.
        this.front.push({ id, dataSize });
      }
      return null;
    }
    this.queued.add(id);
    this.wanted += 1;
    (front ? this.front : this.queue).push({ id, dataSize });
    this.pump();
    return null;
  }

  private pump(): void {
    const max = this.opts.concurrency ?? 6;
    while (this.active < max && (this.front.length || this.queue.length)) {
      const job = this.front.length ? this.front.pop()! : this.queue.shift()!;
      if (!this.queued.has(job.id) || this.inflight.has(job.id)) continue;
      this.queued.delete(job.id);
      this.inflight.add(job.id);
      this.active += 1;
      const gen = this.generation;
      this.fetchMeta(job.id, job.dataSize)
        .then((r) => {
          this.cache.set(job.id, r);
          this.opts.onResult(job.id, r);
        })
        .finally(() => {
          this.active -= 1;
          this.inflight.delete(job.id);
          if (gen === this.generation) this.loaded += 1;
          this.pump();
        });
    }
  }

  /**
   * Fetches one record and checks its length against the index's data_size.
   * Retries once after a pause when it did not land.
   */
  async fetchMeta(id: string, dataSize: number | null): Promise<NameResult> {
    let out: NameResult = { ok: false, name: null, meta: null, why: 'not fetched' };
    try {
      const { status, bytes } = await this.opts.fetchRecord(id);
      if (status !== 200) out.why = status === 404 ? 'the gateway does not have the record (404)' : `the gateway answered HTTP ${status}`;
      else if (dataSize != null && bytes.length !== dataSize) {
        out = { ok: false, name: null, meta: null, why: `the gateway's record is ${bytes.length} bytes; the index says ${dataSize.toLocaleString()}` };
      } else {
        let meta: unknown = null;
        try {
          meta = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          out.why = 'the record is not JSON';
        }
        if (meta !== null) {
          const m = typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
          out = { ok: true, name: typeof m.name === 'string' ? m.name : null, meta: m, why: null };
        }
      }
    } catch (e) {
      out.why = e instanceof Error && e.name === 'AbortError' ? 'no answer in 12 seconds' : 'unreachable';
    }
    if (!out.ok && !this.retried.has(id)) {
      this.retried.add(id);
      await new Promise((r) => setTimeout(r, this.opts.retryAfterMs ?? 4000));
      return this.fetchMeta(id, dataSize);
    }
    return out;
  }
}
