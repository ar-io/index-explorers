/** How a results table writes a number: separators, except for a year. */
import { describe, expect, it } from 'vitest';

import { cellNum, num } from '../src/index.js';

describe('cellNum', () => {
  it('writes a year as it is, in a column named as one', () => {
    for (const c of ['yr', 'year', 'YEAR', 'mined_year', 'first_yr'])
      expect(cellNum(c, 2026), c).toBe('2026');
    // As DuckDB-WASM hands year() back: a BigInt.
    expect(cellNum('yr', 2026n)).toBe('2026');
    expect(cellNum('year', '2018')).toBe('2018');
  });

  it('keeps the separators everywhere else', () => {
    expect(cellNum('n', 2026)).toBe(num(2026));
    expect(cellNum('height', 1_500_000)).toBe(num(1_500_000));
    expect(cellNum('years', 2026)).toBe(num(2026));
    expect(cellNum('yearly_txs', 2026)).toBe(num(2026));
    // Not a plausible year, whatever the column says.
    expect(cellNum('year', 12_345)).toBe(num(12_345));
    expect(cellNum('year', 2026.5)).toBe(num(2026.5));
    expect(cellNum('year', 0)).toBe('0');
  });
});
