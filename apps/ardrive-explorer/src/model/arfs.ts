/**
 * ArFS records as a file system: the newest version of every folder and file
 * (ArFS: several records may share a File-Id or Folder-Id after renames and
 * moves; the newest by height, then Unix-Time, wins), the tree of children,
 * the root, and the path to a folder. Pure: no DOM, no fetch.
 */

/** One ArFS record as the layout's `entities` view returns it, with Numbers at the boundary. */
export interface EntityRecord {
  id: string;
  height: number;
  created_at: number | null;
  owner: string;
  kind: string;
  drive_id: string | null;
  entity_id: string | null;
  parent_folder_id: string | null;
  privacy: string;
  cipher: string | null;
  arfs: string | null;
  app: string | null;
  app_version: string | null;
  unix_time: number | null;
  is_hidden: string | null;
  record_size: number | null;
}

/** Arrow rows are proxies and hold BigInts: convert once, here. */
export function toRecord(r: Record<string, unknown>): EntityRecord {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    height: Number(r.height),
    created_at: num(r.created_at),
    owner: String(r.owner ?? ''),
    kind: String(r.kind ?? ''),
    drive_id: str(r.drive_id),
    entity_id: str(r.entity_id),
    parent_folder_id: str(r.parent_folder_id),
    privacy: String(r.privacy ?? 'public'),
    cipher: str(r.cipher),
    arfs: str(r.arfs),
    app: str(r.app),
    app_version: str(r.app_version),
    unix_time: num(r.unix_time),
    is_hidden: str(r.is_hidden),
    record_size: num(r.record_size),
  };
}

export interface RecordMeta {
  name?: unknown;
  size?: unknown;
  lastModifiedDate?: unknown;
  dataTxId?: unknown;
  dataContentType?: unknown;
  rootFolderId?: unknown;
  [k: string]: unknown;
}

export interface DriveItem {
  kind: 'file' | 'folder';
  entityId: string;
  latest: EntityRecord;
  /** Every version, newest first. */
  versions: EntityRecord[];
  parent: string | null;
  hidden: boolean;
  /** From the record's JSON, once fetched. Null until then; '' never. */
  name: string | null;
  meta: RecordMeta | null;
  /** Why the record could not be read, when it could not. */
  failed: string | null;
  size: number | null;
  modified: number | null;
  type: string | null;
  /** Lower-cased name for sorting, or a sentinel that sorts unnamed items last. */
  sortKey: string;
}

export interface DriveModel {
  driveId: string;
  driveRec: EntityRecord | null;
  privacy: 'public' | 'private';
  capped: boolean;
  items: DriveItem[];
  byId: Map<string, DriveItem>;
  /** By the id of the newest record, which is the one whose JSON is fetched. */
  byRecordId: Map<string, DriveItem>;
  folders: Map<string, DriveItem>;
  children: Map<string, DriveItem[]>;
  roots: DriveItem[];
  rootFolderId: string | null;
  name: string | null;
  /** Files whose size is known from their records, and the sum. */
  sizeKnown: number;
  bytes: number;
  files: number;
  note: string;
}

export const ROOT_KEY = '(root)';

const later = (a: EntityRecord, b: EntityRecord): number =>
  b.height - a.height || (b.unix_time ?? 0) - (a.unix_time ?? 0);

export const sortKeyOf = (name: string | null, entityId: string): string =>
  name ? name.toLowerCase() : '￿' + entityId;

/** Builds the model from a drive's records (every version). */
export function buildDriveModel(
  recs: EntityRecord[],
  opts: { driveId: string; capped: boolean; note?: string },
): DriveModel {
  const byEntity = new Map<
    string,
    { kind: 'file' | 'folder'; id: string; versions: EntityRecord[] }
  >();
  for (const r of recs) {
    if (!r.entity_id || (r.kind !== 'file' && r.kind !== 'folder')) continue;
    const key = `${r.kind}:${r.entity_id}`;
    const e = byEntity.get(key) || { kind: r.kind, id: r.entity_id, versions: [] };
    e.versions.push(r);
    byEntity.set(key, e);
  }
  const driveRec = recs.filter((x) => x.kind === 'drive').sort(later)[0] ?? null;
  const privacy: 'public' | 'private' = driveRec
    ? driveRec.privacy === 'private'
      ? 'private'
      : 'public'
    : recs.some((x) => x.cipher)
      ? 'private'
      : 'public';
  const items: DriveItem[] = [];
  for (const e of byEntity.values()) {
    e.versions.sort(later);
    const v = e.versions[0]!;
    items.push({
      kind: e.kind,
      entityId: e.id,
      latest: v,
      versions: e.versions,
      parent: v.parent_folder_id || null,
      hidden: v.is_hidden === 'true',
      name: null,
      meta: null,
      failed: null,
      size: null,
      modified: null,
      type: null,
      sortKey: sortKeyOf(null, e.id),
    });
  }
  const folders = new Map(items.filter((x) => x.kind === 'folder').map((x) => [x.entityId, x]));
  const byId = new Map(items.map((x) => [x.entityId, x]));
  const byRecordId = new Map(items.map((x) => [x.latest.id, x]));
  const children = new Map<string, DriveItem[]>();
  for (const x of items) {
    const k = x.parent && folders.has(x.parent) ? x.parent : ROOT_KEY;
    let list = children.get(k);
    if (!list) children.set(k, (list = []));
    list.push(x);
  }
  // The root: a folder with no parent. Where several qualify (a subtree whose
  // parent is outside the listing), each becomes a top-level entry.
  const roots = items.filter((x) => x.kind === 'folder' && (!x.parent || !folders.has(x.parent)));
  return {
    driveId: opts.driveId,
    driveRec,
    privacy,
    capped: opts.capped,
    items,
    byId,
    byRecordId,
    folders,
    children,
    roots,
    rootFolderId: null,
    name: null,
    sizeKnown: 0,
    bytes: 0,
    files: items.filter((x) => x.kind === 'file').length,
    note: opts.note ?? '',
  };
}

/** The drive's own record landed: its name and root folder. */
export function setDriveMeta(m: DriveModel, meta: RecordMeta | null, name: string | null): void {
  m.name = name ?? (meta ? 'Unnamed drive' : null);
  const root = meta && typeof meta.rootFolderId === 'string' ? meta.rootFolderId : null;
  if (root && m.folders.has(root)) {
    m.rootFolderId = root;
    const rf = m.folders.get(root)!;
    m.roots = [rf, ...m.roots.filter((r) => r !== rf)];
  }
}

/** One record landed: the item's name, size, type and date. */
export function applyMeta(
  m: DriveModel,
  x: DriveItem,
  r: { ok: boolean; name: string | null; meta: RecordMeta | null; why: string | null },
): void {
  if (!r.ok) {
    x.failed = r.why || 'not readable';
    x.meta = null;
    x.name = null;
  } else {
    x.meta = r.meta ?? {};
    x.failed = null;
    x.name = r.name ?? (x.kind === 'folder' ? 'Unnamed folder' : 'Unnamed file');
    if (x.kind === 'file' && r.meta) {
      const size = Number(r.meta.size);
      if (r.meta.size != null && Number.isFinite(size) && x.size === null) {
        x.size = size;
        m.sizeKnown += 1;
        m.bytes += size;
      }
      x.type = typeof r.meta.dataContentType === 'string' ? r.meta.dataContentType : null;
      const lm = Number(r.meta.lastModifiedDate);
      x.modified =
        r.meta.lastModifiedDate != null && Number.isFinite(lm) && lm > 0 && lm < 4e12 ? lm : null;
    }
  }
  x.sortKey = sortKeyOf(x.name, x.entityId);
}

/** The path from the root to a folder, by walking parents (the single root is implicit). */
export function pathTo(m: DriveModel, folder: DriveItem): string[] {
  const out: string[] = [];
  let f: DriveItem | undefined = folder;
  let guard = 0;
  while (f && guard++ < 64) {
    if (m.roots.length === 1 && f === m.roots[0]) break;
    out.unshift(f.entityId);
    f = f.parent ? m.folders.get(f.parent) : undefined;
  }
  return out;
}

export const currentFolder = (m: DriveModel, path: readonly string[]): DriveItem | null =>
  path.length ? (m.folders.get(path[path.length - 1]!) ?? null) : null;

/** What a folder shows, or every item matching a search. */
export function visibleItems(m: DriveModel, path: readonly string[], filter: string): DriveItem[] {
  if (filter) {
    const f = filter.toLowerCase();
    // Ids match only for something id-like: one letter is in nearly every uuid.
    const byId = f.length >= 6 && /^[0-9a-f-]+$/.test(f);
    return m.items.filter(
      (x) => (x.name || '').toLowerCase().includes(f) || (byId && x.entityId.includes(f)),
    );
  }
  const cur = currentFolder(m, path);
  if (!cur) {
    // Orphans (a parent folder outside the listing) show at the root rather than vanish.
    const orphans = (m.children.get(ROOT_KEY) ?? []).filter((x) => x.kind !== 'folder');
    if (m.roots.length === 1) return [...(m.children.get(m.roots[0]!.entityId) ?? []), ...orphans];
    return [...m.roots, ...orphans];
  }
  return m.children.get(cur.entityId) ?? [];
}

export type SortKey = 'name' | 'modified' | 'size' | 'type';

/**
 * Folders first, then by the key. One collator for every sort: localeCompare
 * with options builds one per call, seconds over twenty thousand rows.
 */
export function sortItems(
  m: DriveModel,
  list: DriveItem[],
  key: SortKey,
  dir: 1 | -1,
  collator: Intl.Collator,
): DriveItem[] {
  const numeric = key === 'modified' || key === 'size';
  const val = (x: DriveItem): string | number =>
    key === 'modified'
      ? (x.modified ?? x.latest.created_at ?? 0)
      : key === 'size'
        ? (x.size ?? 0)
        : key === 'type'
          ? x.kind === 'folder'
            ? ''
            : x.type || ''
          : x.sortKey;
  const out = list.slice();
  out.sort((a, b) => {
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
    return (
      (numeric
        ? (val(a) as number) - (val(b) as number)
        : collator.compare(val(a) as string, val(b) as string)) * dir
    );
  });
  void m;
  return out;
}
