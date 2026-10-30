/**
 * What the pages say when something goes wrong: failovers grouped and
 * counted rather than a sentence per band file, and per gateway why none
 * offered the index (unreachable is not "publishes no index").
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';

import {
  addNote,
  engineErrorText,
  explainReadError,
  NoGatewayError,
  notesText,
  pickGateway,
  type Watch,
  type WatchNote,
} from '../src/index.js';
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

describe('a spent engine', () => {
  it('says the memory ran out, over the period, whichever way the engine reports it', () => {
    for (const raw of [
      'Out of Memory Error: could not allocate block of size 256 KiB',
      "Invalid Input Error: File 'r112_tg.parquet' too small to be a Parquet file",
      'IO Error: No files found that match the pattern "r409_it.parquet"',
    ]) {
      const why = explainReadError(new Error(raw), null, [], 'Last 12 months');
      expect(why.oom).toBe(true);
      expect(why.msg).toMatch(
        /^This question needs more memory than a browser tab allows over Last 12 months\./,
      );
      expect(why.msg).not.toMatch(/parquet|Error/);
      expect(why.detail).toBe(raw);
    }
  });

  it('a file the reader refused is the reader’s failure, not the engine’s', () => {
    const watch = { fail: { code: 'integrity', msg: 'a piece did not match' } } as unknown as Watch;
    const why = explainReadError(
      new Error("Invalid Input Error: File 'r1_tg.parquet' too small to be a Parquet file"),
      watch,
      [],
    );
    expect(why.oom).toBeUndefined();
    expect(why.integrity).toBe(true);
  });
});

describe('engine errors about the question', () => {
  // As DuckDB words them (native 1.x and the wasm build alike).
  it('says the error in a sentence and keeps the pointer into the query apart', () => {
    const e = engineErrorText(
      'Parser Error: syntax error at or near "selct"\n\nLINE 1: selct 1\n        ^',
    );
    expect(e).toEqual({
      msg: 'Syntax error at or near "selct".',
      query: true,
      context: 'LINE 1: selct 1\n        ^',
    });
  });

  it('keeps the hint DuckDB gives, as part of the sentence', () => {
    expect(
      engineErrorText(
        'Catalog Error: Table with name foo does not exist!\nDid you mean "files"?\n\nLINE 1: select * from foo\n                      ^',
      ).msg,
    ).toBe('Table with name foo does not exist. Did you mean "files"?');
    expect(
      engineErrorText(
        'Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "range"\n\nLINE 1: select nope from range(3)\n               ^',
      ).msg,
    ).toBe('Referenced column "nope" not found in FROM clause. Candidate bindings: "range".');
    expect(engineErrorText('Parser Error: syntax error at end of input')).toEqual({
      msg: 'Syntax error at end of input.',
      query: true,
    });
  });

  it('answers an unknown table with the tables the page defines, in place of DuckDB’s guess', async () => {
    // As DuckDB says it: the guess is the nearest name in the catalog, here `tags`.
    const db = await (await DuckDBInstance.create(':memory:')).connect();
    await db.run('CREATE VIEW txs AS SELECT 1 AS height');
    await db.run('CREATE VIEW tags AS SELECT 1 AS height');
    const said = await db.run('SELECT * FROM transactions').then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(said).toMatch(/^Catalog Error: Table with name transactions does not exist!/);
    expect(engineErrorText(said).msg).toMatch(/Did you mean/);
    const e = engineErrorText(said, ['txs', 'blocks', 'tags']);
    expect(e.msg).toBe(
      'Table with name transactions does not exist. The tables here are txs, blocks and tags.',
    );
    expect(e.query).toBe(true);
    expect(e.context).toMatch(/^LINE 1: SELECT \* FROM transactions/);
    const why = explainReadError(new Error(said), null, [], undefined, ['txs']);
    expect(why.msg).toBe('Table with name transactions does not exist. The tables here are txs.');
    // Any other catalog error keeps DuckDB's words.
    expect(
      engineErrorText('Catalog Error: Scalar Function with name nope does not exist!', ['txs']).msg,
    ).toBe('Scalar Function with name nope does not exist.');
  });

  it('leaves anything else whole, and explainReadError passes the question’s errors through', () => {
    expect(engineErrorText('IO Error: Cannot open file "x"')).toEqual({
      msg: 'IO Error: Cannot open file "x"',
      query: false,
    });
    const why = explainReadError(
      new Error(
        "Conversion Error: Could not convert string 'a' to INT32\n\nLINE 1: select 'a'::int\n                  ^",
      ),
      null,
      [],
    );
    expect(why.query).toBe(true);
    expect(why.msg).toBe("Could not convert string 'a' to INT32.");
    expect(why.context).toMatch(/^LINE 1/);
  });
});
