/**
 * Arrow tables to plain records, column by column. Arrow rows are proxies:
 * reading twenty thousand of them field by field is slow, and a spread loses
 * fields; reading each column's vector once is fast and gives plain values
 * (BigInts included, converted here).
 */
import type { Table } from 'apache-arrow';

import type { EntityRecord } from './arfs.js';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function toRecords(table: Table, from = 0, to = table.numRows): EntityRecord[] {
  const n = to - from;
  // A slice first: toArray() decodes every value it covers, and a chunk must
  // decode only its own rows, not the whole column each time.
  const col = (name: string): unknown[] => {
    const v = table.getChild(name);
    return v
      ? (v.slice(from, to).toArray() as unknown as ArrayLike<unknown> as unknown[])
      : new Array<unknown>(n).fill(null);
  };
  const id = col('id');
  const height = col('height');
  // A timestamp's raw array is the engine's unit (microseconds); get() gives epoch milliseconds.
  const createdVec = table.getChild('created_at')?.slice(from, to) ?? null;
  const owner = col('owner');
  const kind = col('kind');
  const driveId = col('drive_id');
  const entityId = col('entity_id');
  const parent = col('parent_folder_id');
  const privacy = col('privacy');
  const cipher = col('cipher');
  const arfs = col('arfs');
  const app = col('app');
  const appVersion = col('app_version');
  const unixTime = col('unix_time');
  const hidden = col('is_hidden');
  const recordSize = col('record_size');
  const out: EntityRecord[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const i = k;
    out[k] = {
      id: String(id[i]),
      height: Number(height[i]),
      created_at: createdVec ? num(createdVec.get(i)) : null,
      owner: String(owner[i] ?? ''),
      kind: String(kind[i] ?? ''),
      drive_id: str(driveId[i]),
      entity_id: str(entityId[i]),
      parent_folder_id: str(parent[i]),
      privacy: String(privacy[i] ?? 'public'),
      cipher: str(cipher[i]),
      arfs: str(arfs[i]),
      app: str(app[i]),
      app_version: str(appVersion[i]),
      unix_time: num(unixTime[i]),
      is_hidden: str(hidden[i]),
      record_size: num(recordSize[i]),
    };
  }
  return out;
}

/** Lets the browser paint and handle input between two long steps of work. */
export const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * The same, a few thousand rows per task: decoding twenty thousand rows of
 * strings in one go is a long task, and the main thread is also drawing.
 */
export async function toRecordsChunked(
  table: Table,
  chunk = 4000,
  onChunk?: () => void,
): Promise<EntityRecord[]> {
  const out: EntityRecord[] = [];
  for (let at = 0; at < table.numRows; at += chunk) {
    if (at > 0) await yieldToBrowser();
    const part = toRecords(table, at, Math.min(at + chunk, table.numRows));
    for (const r of part) out.push(r);
    onChunk?.();
  }
  return out;
}
