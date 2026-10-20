import { describe, expect, it, vi } from 'vitest';

import { NamePool } from './names.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('NamePool', () => {
  it('serves what is on screen first, a few at a time, and caches', async () => {
    const order: string[] = [];
    let release: (() => void)[] = [];
    const fetchRecord = vi.fn(async (id: string) => {
      order.push(id);
      await new Promise<void>((r) => release.push(r));
      return { status: 200, bytes: enc(JSON.stringify({ name: 'N' + id })) };
    });
    const results: string[] = [];
    const pool = new NamePool({ fetchRecord, concurrency: 2, onResult: (id) => results.push(id) });
    for (const id of ['a', 'b', 'c', 'd']) pool.want(id, null, false);
    pool.want('e', null, true);
    pool.want('f', null, true);
    expect(order).toEqual(['a', 'b']); // two in flight already
    release.forEach((r) => r());
    release = [];
    await new Promise((r) => setTimeout(r, 0));
    // Front jobs come next, newest first, then the queue in order.
    expect(order.slice(2, 4)).toEqual(['f', 'e']);
    release.forEach((r) => r());
    release = [];
    await new Promise((r) => setTimeout(r, 0));
    expect(order.slice(4)).toEqual(['c', 'd']);
    release.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
    expect(results.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(pool.want('a', null, false)?.name).toBe('Na');
    expect(fetchRecord).toHaveBeenCalledTimes(6);
    expect(pool.pending).toBe(0);
  });

  it('refuses a record whose length differs from the index, and retries a failure once', async () => {
    let calls = 0;
    const fetchRecord = async (id: string) => {
      calls++;
      if (id === 'short') return { status: 200, bytes: enc('{"name":"x"}') };
      if (id === 'flaky') return calls < 3 ? { status: 503, bytes: new Uint8Array(0) } : { status: 200, bytes: enc('{"name":"ok"}') };
      return { status: 404, bytes: new Uint8Array(0) };
    };
    const got = new Map<string, { ok: boolean; why: string | null; name: string | null }>();
    const pool = new NamePool({ fetchRecord, concurrency: 1, retryAfterMs: 1, onResult: (id, r) => got.set(id, r) });
    pool.want('short', 500, true);
    await vi.waitFor(() => expect(got.has('short')).toBe(true));
    expect(got.get('short')!.ok).toBe(false);
    expect(got.get('short')!.why).toMatch(/index says 500/);
    pool.want('flaky', null, true);
    await vi.waitFor(() => expect(got.has('flaky')).toBe(true));
    expect(got.get('flaky')!.ok).toBe(true);
    pool.want('missing', null, true);
    await vi.waitFor(() => expect(got.has('missing')).toBe(true));
    expect(got.get('missing')!.why).toMatch(/404/);
  });

  it('reset forgets the queue and progress but keeps the cache', async () => {
    const fetchRecord = async () => ({ status: 200, bytes: enc('{"name":"n"}') });
    const pool = new NamePool({ fetchRecord, concurrency: 1, onResult: () => {} });
    pool.want('a', null, false);
    await vi.waitFor(() => expect(pool.want('a', null, false)).not.toBeNull());
    for (let i = 0; i < 100; i++) pool.want('q' + i, null, false);
    expect(pool.wanted).toBeGreaterThan(50);
    pool.reset();
    expect(pool.wanted).toBe(0);
    expect(pool.want('a', null, false)?.name).toBe('n');
  });
});
