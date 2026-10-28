import { describe, expect, it } from 'vitest';

import { blockSpan, blocksScope, lookupSql } from './questions.js';

const bands = [
  { from: 2_000_000, to: 2_009_999, fromTime: 1_760_000_000, toTime: 1_761_000_000 },
  { from: 2_010_000, to: 2_030_390, fromTime: 1_761_000_000, toTime: 1_761_600_000 },
];
const latest: [number, number] = [2_030_000, 2_030_390];
const at = (raw: string, canWiden = false) => {
  const span = blockSpan(raw)!;
  return blocksScope(span, span.range ? 'These blocks' : 'Block', bands, latest, { canWiden });
};

describe('Find on blocks', () => {
  it('reads heights and ranges, either way round, with separators', () => {
    expect(blockSpan('2,015,000')).toEqual({ lo: 2_015_000, hi: 2_015_000, range: false });
    expect(blockSpan('2015100 - 2015000')).toEqual({ lo: 2_015_000, hi: 2_015_100, range: true });
    expect(blockSpan('abc')).toBeNull();
    expect(lookupSql('2015000')).toMatch(/WHERE height = 2015000/);
    expect(lookupSql('2015000..2015100')).toMatch(/BETWEEN 2015000 AND 2015100/);
  });

  it('runs a block in the period as it is', () => {
    expect(at('2030100')).toEqual({ run: true });
    expect(at('2029990-2030010')).toEqual({ run: true });
  });

  it('looks over everything for a block outside the period, given range reads', () => {
    expect(at('2015000', true)).toEqual({ run: true, widen: true });
  });

  it('otherwise names the period that holds it, never "0 rows"', () => {
    const r = at('2015000');
    expect(r.run).toBe(false);
    expect(r.say).toMatch(
      /^Block is outside the period chosen \(blocks 2,030,000 to 2,030,390\)\. Under Period, pick “One period…” and the one from /,
    );
  });

  it('says when blocks are newer or older than the whole index', () => {
    expect(at('2040000', true)).toEqual({
      run: false,
      say: 'Block is newer than this index, which reaches block 2,030,390. The publisher adds new blocks as it updates its newest band.',
    });
    expect(at('1000-1999', true).say).toBe(
      'These blocks are older than this index, which starts at block 2,000,000.',
    );
  });
});
