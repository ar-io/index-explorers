/**
 * Which `parquet-l2` index holds what: the selection every band declares,
 * checked against the recorded publication and edited copies of it.
 */
import { describe, expect, it } from 'vitest';

import { arfs, parsePublication, parquetL2, type Publication } from '../src/index.js';
import { LIVE_PUBLICATION, readJson } from './helpers.js';

type Raw = Record<string, unknown>;
const raw = readJson(LIVE_PUBLICATION) as Raw;
const ARDRIVE = arfs.ARDRIVE_SELECTION;

/** The recorded publication with its ardrive-l2 index edited: unsigned, which these functions never look at. */
const edited = (f: (ix: Raw & { bands: Raw[] }) => void): Publication => {
  const doc = JSON.parse(JSON.stringify(raw)) as { indexes: (Raw & { bands: Raw[] })[] };
  f(doc.indexes.find((i) => i.name === 'ardrive-l2')!);
  return parsePublication(doc);
};
const selectAll = (ix: { bands: Raw[] }, sel: unknown) => {
  for (const b of ix.bands) (b.metadata as Raw).selection = sel;
};
const ardriveIx = (doc: Publication) => doc.indexes.find((i) => i.name === 'ardrive-l2')!;

describe('parseL2Selection', () => {
  it('accepts a selection with and without an excluded prefix', () => {
    expect(parquetL2.parseL2Selection(ARDRIVE)).toEqual(ARDRIVE);
    const plain = { kind: 'ans104-data-items', tag: { name: 'App-Name', valuePrefix: 'Odysee' } };
    expect(parquetL2.parseL2Selection(plain)).toEqual(plain);
  });

  it('refuses another kind, an extra field, an exclusion that does not extend the prefix, an oversize value and an empty name', () => {
    const tag = { name: 'App-Name', valuePrefix: 'ArDrive' };
    for (const [bad, why] of [
      [{ kind: 'transactions', tag }, /kind/],
      [{ kind: 'ans104-data-items', tag, extra: 1 }, /extra is not allowed/],
      [{ kind: 'ans104-data-items', tag: { ...tag, owner: 'x' } }, /tag\.owner is not allowed/],
      [{ kind: 'ans104-data-items', tag: { ...tag, excludeValuePrefix: 'Odysee' } }, /must extend/],
      [
        { kind: 'ans104-data-items', tag: { ...tag, excludeValuePrefix: 'ArDrive' } },
        /must extend/,
      ],
      [{ kind: 'ans104-data-items', tag: { ...tag, valuePrefix: 'é'.repeat(129) } }, /too long/],
      [{ kind: 'ans104-data-items', tag: { ...tag, name: '' } }, /empty/],
      [{ kind: 'ans104-data-items', tag: { name: 'App-Name' } }, /valuePrefix/],
    ] as const)
      expect(() => parquetL2.parseL2Selection(bad), JSON.stringify(bad)).toThrow(why);
  });
});

describe('l2SelectionOf and findL2Index', () => {
  it("reads ardrive-l2's selection from the recorded publication: ArDrive's", () => {
    const doc = parsePublication(raw);
    expect(parquetL2.l2SelectionOf(ardriveIx(doc))).toEqual(ARDRIVE);
    expect(parquetL2.findL2Index(doc, ARDRIVE, 'ardrive-l2')).toEqual({ name: 'ardrive-l2' });
  });

  it('finds the same selection under another name', () => {
    const doc = edited((ix) => (ix.name = 'ardrive-items'));
    expect(parquetL2.findL2Index(doc, ARDRIVE, 'ardrive-l2')).toEqual({ name: 'ardrive-items' });
  });

  it('refuses the preferred name when it selects something else, and says what it selects', () => {
    const doc = edited((ix) =>
      selectAll(ix, {
        kind: 'ans104-data-items',
        tag: { name: 'App-Name', valuePrefix: 'ArDrive', excludeValuePrefix: 'ArDrive-Test' },
      }),
    );
    const found = parquetL2.findL2Index(doc, ARDRIVE, 'ardrive-l2');
    expect(found.name).toBeNull();
    expect(found).toMatchObject({
      why: expect.stringContaining(
        'ardrive-l2 selects App-Name starting "ArDrive", not "ArDrive-Test"',
      ),
    });
  });

  it('refuses an index whose bands disagree, or one with no selection, naming the band', () => {
    let id = '';
    const split = edited((ix) => {
      id = ix.bands[1]!.id as string;
      (ix.bands[1]!.metadata as Raw).selection = {
        kind: 'ans104-data-items',
        tag: { name: 'App-Name', valuePrefix: 'Ar' },
      };
    });
    expect(() => parquetL2.l2SelectionOf(ardriveIx(split))).toThrow(id);
    expect(parquetL2.findL2Index(split, ARDRIVE, 'ardrive-l2')).toMatchObject({
      name: null,
      why: expect.stringContaining(id),
    });
    const none = edited((ix) => delete (ix.bands[0]!.metadata as Raw).selection);
    expect(() => parquetL2.l2SelectionOf(ardriveIx(none))).toThrow(/declares no selection/);
  });

  it("holds the index's filter to its bands' selection", () => {
    const same = edited((ix) => (ix.filter = ARDRIVE));
    expect(parquetL2.l2SelectionOf(ardriveIx(same))).toEqual(ARDRIVE);
    const other = edited(
      (ix) =>
        (ix.filter = {
          kind: 'ans104-data-items',
          tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
        }),
    );
    expect(() => parquetL2.l2SelectionOf(ardriveIx(other))).toThrow(/filter selects/);
  });
});
