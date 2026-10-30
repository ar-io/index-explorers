import type { Band } from '@ar-io/index-client';
import { describe, expect, it } from 'vitest';

import type { Session } from '../session.js';
import { Store } from '../store.js';
import { createQueryFlow } from './query.js';

/** Just enough of a session for the query flow: one large period, and an engine that runs out of memory. */
function fixture() {
  const store = new Store();
  store.periods.value = [
    { id: 'y12', label: 'Last 12 months', lo: 1, hi: 2, bands: [{} as Band], size: 2e9 },
  ];
  store.periodId.value = 'y12';
  let reads = 0;
  const s = {
    store,
    nav: 0,
    bands: [],
    lastReadOom: false,
    ready: async () => true,
    recovers: 0,
    recovered: true,
    async recover() {
      s.recovers += 1;
      return s.recovered;
    },
    overtaken: () => false,
    clearView: () => {},
    pushHistory: () => {},
    isRangeable: () => true,
    async measured() {
      reads += 1;
      s.lastReadOom = true;
      store.say(
        'This question needs more memory than a browser tab allows over Last 12 months.',
        'bad',
      );
      return null;
    },
  };
  return { s, store, flow: createQueryFlow(s as unknown as Session), reads: () => reads };
}

describe('a typed query', () => {
  it('says to type one first when the editor is empty', async () => {
    const { store, flow } = fixture();
    store.say('an earlier failure', 'bad');
    await flow.runQuery({ sql: '  ' });
    expect(store.status.value).toEqual({ text: 'Type a query first.', cls: 'bad' });
  });

  it('reads the publication again first, after it failed, and asks nothing when it still fails', async () => {
    const { s, flow, reads } = fixture();
    s.recovered = false;
    await flow.runQuery({ sql: 'SELECT 1', confirmed: true });
    expect(s.recovers).toBe(1);
    expect(reads()).toBe(0);
    s.recovered = true;
    await flow.runQuery({ sql: 'SELECT 1', confirmed: true });
    expect(s.recovers).toBe(2);
    expect(reads()).toBe(1);
  });

  it('shows why it failed where the answer would be', async () => {
    const { store, flow } = fixture();
    await flow.runQuery({ sql: 'SELECT 1', confirmed: true });
    expect(store.content.value.title).toBe('Your query');
    expect(store.content.value.sub).toMatch(/needs more memory/);
    expect(store.content.value.table).toBeNull();
  });

  it('is not offered again over a period it ran out of memory over', async () => {
    const { store, flow, reads } = fixture();
    const sql = 'SELECT month, count(*) FROM uploads GROUP BY 1';
    await flow.runQuery({ sql });
    expect(store.content.value.cost?.action?.label).toBe('Run it over Last 12 months');
    store.content.value.cost!.action!.go();
    await new Promise((r) => setTimeout(r, 0));
    expect(reads()).toBe(1);
    await flow.runQuery({ sql });
    const cost = store.content.value.cost!;
    expect(cost.action).toBeNull();
    expect((cost.text as string[]).join('')).toMatch(
      /ran out of a tab’s memory over Last 12 months earlier in this tab/,
    );
    // Another query over the same period is still offered.
    await flow.runQuery({ sql: 'SELECT 2' });
    expect(store.content.value.cost?.action).not.toBeNull();
  });
});
