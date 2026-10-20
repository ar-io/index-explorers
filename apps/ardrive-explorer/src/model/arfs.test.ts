import { describe, expect, it } from 'vitest';

import {
  applyMeta,
  buildDriveModel,
  type EntityRecord,
  pathTo,
  setDriveMeta,
  sortItems,
  toRecord,
  visibleItems,
} from './arfs.js';

const rec = (over: Partial<EntityRecord>): EntityRecord => ({
  id: 'id',
  height: 1,
  created_at: 1000,
  owner: 'o',
  kind: 'file',
  drive_id: 'd',
  entity_id: null,
  parent_folder_id: null,
  privacy: 'public',
  cipher: null,
  arfs: '0.15',
  app: 'ArDrive-App',
  app_version: '1',
  unix_time: 1,
  is_hidden: null,
  record_size: 100,
  ...over,
});

const records: EntityRecord[] = [
  rec({ id: 'drive', kind: 'drive', entity_id: 'd', height: 10 }),
  rec({ id: 'root', kind: 'folder', entity_id: 'root', height: 10 }),
  rec({ id: 'a1', kind: 'folder', entity_id: 'a', parent_folder_id: 'root', height: 11 }),
  rec({ id: 'b1', kind: 'folder', entity_id: 'b', parent_folder_id: 'a', height: 12 }),
  rec({ id: 'f1', kind: 'file', entity_id: 'f', parent_folder_id: 'b', height: 12, unix_time: 5 }),
  rec({ id: 'f2', kind: 'file', entity_id: 'f', parent_folder_id: 'b', height: 13, unix_time: 1 }),
  rec({ id: 'f3', kind: 'file', entity_id: 'f', parent_folder_id: 'b', height: 13, unix_time: 9 }),
  rec({
    id: 'g1',
    kind: 'file',
    entity_id: 'g',
    parent_folder_id: 'root',
    height: 11,
    is_hidden: 'true',
  }),
  rec({ id: 'orphan', kind: 'file', entity_id: 'h', parent_folder_id: 'missing', height: 11 }),
  rec({ id: 'snap', kind: 'snapshot', entity_id: null, height: 11 }),
];

describe('buildDriveModel', () => {
  const m = buildDriveModel(records, { driveId: 'd', capped: false });

  it('keeps the newest version per entity (height, then Unix-Time) and counts the rest', () => {
    const f = m.byId.get('f')!;
    expect(f.latest.id).toBe('f3');
    expect(f.versions.map((v) => v.id)).toEqual(['f3', 'f2', 'f1']);
    expect(m.files).toBe(3);
    expect(m.folders.size).toBe(3);
    expect(m.driveRec?.id).toBe('drive');
    expect(m.privacy).toBe('public');
  });

  it('finds the single root, nests children and puts orphans at the root', () => {
    expect(m.roots.map((r) => r.entityId)).toEqual(['root']);
    expect(
      visibleItems(m, [], '')
        .map((x) => x.entityId)
        .sort(),
    ).toEqual(['a', 'g', 'h']);
    expect(visibleItems(m, ['a'], '').map((x) => x.entityId)).toEqual(['b']);
    expect(visibleItems(m, ['a', 'b'], '').map((x) => x.entityId)).toEqual(['f']);
    expect(m.byId.get('g')!.hidden).toBe(true);
  });

  it('walks the path to a folder, leaving the implicit root out', () => {
    expect(pathTo(m, m.folders.get('b')!)).toEqual(['a', 'b']);
    expect(pathTo(m, m.folders.get('root')!)).toEqual([]);
  });

  it('applies metadata: names, sizes, types, and failures shown as such', () => {
    const f = m.byId.get('f')!;
    applyMeta(m, f, {
      ok: true,
      name: 'Holiday.jpg',
      meta: { size: 1234, dataContentType: 'image/jpeg', lastModifiedDate: 1700000000000 },
      why: null,
    });
    expect(f.name).toBe('Holiday.jpg');
    expect(f.size).toBe(1234);
    expect(f.type).toBe('image/jpeg');
    expect(f.modified).toBe(1700000000000);
    expect(f.sortKey).toBe('holiday.jpg');
    expect(m.sizeKnown).toBe(1);
    expect(m.bytes).toBe(1234);
    const g = m.byId.get('g')!;
    applyMeta(m, g, {
      ok: false,
      name: null,
      meta: null,
      why: 'the record is 5 bytes; the index says 100',
    });
    expect(g.failed).toMatch(/index says/);
    expect(g.name).toBeNull();
    const h = m.byId.get('h')!;
    applyMeta(m, h, { ok: true, name: null, meta: {}, why: null });
    expect(h.name).toBe('Unnamed file');
  });

  it('searches names and ids across folders', () => {
    expect(visibleItems(m, [], 'holiday').map((x) => x.entityId)).toEqual(['f']);
    // A short filter matches names only (Holiday.jpg has a g; the id 'g' does not count): one letter is in nearly every uuid.
    expect(visibleItems(m, [], 'g').map((x) => x.entityId)).toEqual(['f']);
    expect(visibleItems(m, [], 'zz').map((x) => x.entityId)).toEqual([]);
  });

  it('sorts folders first, then by the chosen key, with one collator', () => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const list = visibleItems(m, [], '');
    const byName = sortItems(m, list, 'name', 1, collator);
    expect(byName[0]!.kind).toBe('folder');
    const bySize = sortItems(m, visibleItems(m, ['a', 'b'], ''), 'size', -1, collator);
    expect(bySize[0]!.entityId).toBe('f');
  });

  it('puts the drive record’s root folder first', () => {
    const two = buildDriveModel(
      [...records, rec({ id: 'r2', kind: 'folder', entity_id: 'root2', height: 9 })],
      { driveId: 'd', capped: false },
    );
    expect(two.roots.length).toBe(2);
    setDriveMeta(two, { name: 'Mine', rootFolderId: 'root2' }, 'Mine');
    expect(two.roots[0]!.entityId).toBe('root2');
    expect(two.name).toBe('Mine');
  });

  it('converts Arrow-like rows with BigInts at the boundary', () => {
    const r = toRecord({
      id: 'x',
      height: 12n,
      created_at: 1700000000000n,
      owner: 'o',
      kind: 'file',
      record_size: 99n,
      unix_time: 1700000000n,
    });
    expect(r.height).toBe(12);
    expect(r.record_size).toBe(99);
    expect(r.created_at).toBe(1700000000000);
    expect(r.drive_id).toBeNull();
  });
});
