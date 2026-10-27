/**
 * What the pages say when something goes wrong: failovers grouped and
 * counted rather than a sentence per band file, and per gateway why none
 * offered the index (unreachable is not "publishes no index").
 */
import { describe, expect, it } from 'vitest';

import { addNote, NoGatewayError, notesText, pickGateway, type WatchNote } from '../src/index.js';
import { LIVE_PUBLICATION, readJson } from './helpers.js';

describe('failover notes', () => {
  it('forty band files missing from one gateway are one counted sentence', () => {
    const notes: WatchNote[] = [];
    for (let i = 0; i < 40; i++)
      addNote(
        notes,
        `gw.example does not have lookup_wallet.parquet for blocks ${i * 100000}–${i * 100000 + 99999}. Trying another source; every byte is still checked.`,
        'gw.example status',
      );
    expect(notes).toHaveLength(1);
    const text = notesText(notes);
    expect(text.match(/Trying another source/g)).toHaveLength(1);
    expect(text).toMatch(/The same happened to 39 more reads\./);
  });

  it('shows at most three kinds, then counts the rest; nothing when there were none', () => {
    const notes: WatchNote[] = [];
    for (const h of ['a', 'b', 'c', 'd', 'e'])
      for (let i = 0; i < 2; i++) addNote(notes, `${h}.example failed (${i})`, `${h} server`);
    const text = notesText(notes);
    expect(text.match(/failed/g)).toHaveLength(3);
    expect(text).toMatch(/4 more reads used another source too\.$/);
    expect(notesText([])).toBe('');
  });

  it('keeps a note without a key as its own kind, and bounds the kinds kept', () => {
    const notes: WatchNote[] = [];
    addNote(notes, 'one');
    addNote(notes, 'one');
    expect(notes).toEqual([{ key: 'One', msg: 'One', count: 2 }]);
    for (let i = 0; i < 100; i++) addNote(notes, `kind ${i}`, `k${i}`);
    expect(notes.length).toBeLessThanOrEqual(20);
    expect(notes.reduce((t, n) => t + n.count, 0)).toBe(102);
  });
});

describe('no gateway offers the index', () => {
  const candidates = ['https://a.example', 'https://b.example'];

  it('says the gateways could not be reached when none answered', async () => {
    const e = await pickGateway({
      choice: 'auto',
      indexName: 'ardrive-l2',
      candidates,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NoGatewayError);
    expect((e as NoGatewayError).unreachable).toBe(true);
    expect((e as Error).message).toBe(
      'could not reach a.example or b.example: the network may be down, or the gateways are',
    );
  });

  it('says which answered without the index and which could not be reached', async () => {
    const doc = readJson(LIVE_PUBLICATION);
    const e = (await pickGateway({
      choice: 'auto',
      indexName: 'some-other-index',
      candidates,
      fetch: (url) =>
        String(url).startsWith('https://a.example')
          ? Promise.resolve(new Response(JSON.stringify(doc)))
          : Promise.reject(new TypeError('Failed to fetch')),
    }).catch((x: unknown) => x)) as NoGatewayError;
    expect(e.unreachable).toBe(false);
    expect(e.message).toBe(
      'no gateway offered a some-other-index index: a.example answered without the index; b.example could not be reached',
    );
  });

  it('keeps the old wording when every gateway answered without the index', async () => {
    const doc = readJson(LIVE_PUBLICATION);
    const e = (await pickGateway({
      choice: 'auto',
      indexName: 'some-other-index',
      candidates,
      fetch: () => Promise.resolve(new Response(JSON.stringify(doc))),
    }).catch((x: unknown) => x)) as NoGatewayError;
    expect(e.message).toBe('none of these publish a some-other-index index: a.example, b.example');
  });
});
