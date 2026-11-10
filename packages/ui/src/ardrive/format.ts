/**
 * How ArDrive writes dates, sizes and file types, in one place: a day in
 * lists ("Oct 13, 2026"), the time added in details, a size scaled to its
 * unit, and a type in words ("JPEG image", "PDF") with the MIME type kept for
 * details. Dates are UTC, as the records stamp them. Pure; cached where a
 * long list calls them per row.
 */

const DAY = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const days = new Map<number, string>();

/** "Oct 13, 2026", from epoch milliseconds; '' for no date. */
export function dateText(ms: unknown): string {
  const n = Number(ms);
  if (!ms || !Number.isFinite(n)) return '';
  const day = Math.floor(n / 86400000);
  let out = days.get(day);
  if (out === undefined) {
    const d = new Date(day * 86400000);
    if (!Number.isFinite(d.getTime())) return '';
    out = DAY.format(d);
    if (days.size > 5000) days.clear();
    days.set(day, out);
  }
  return out;
}

/** "Oct 13, 2026, 08:04 UTC", for details. */
export function dateTimeText(ms: unknown): string {
  const day = dateText(ms);
  if (!day) return '';
  return `${day}, ${TIME.format(new Date(Number(ms)))} UTC`;
}

/** A size scaled to its unit: 108 B, 15.8 KB, 7.34 GB. */
export function sizeText(n: unknown): string {
  const v = Number(n);
  if (n === null || n === undefined || !(v >= 0)) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  if (v < 1099511627776) return `${(v / 1073741824).toFixed(2)} GB`;
  return `${(v / 1099511627776).toFixed(2)} TB`;
}

/** MIME types in words; a subtype not here is named by its family. */
const NAMED: Record<string, string> = {
  'image/jpeg': 'JPEG image',
  'image/png': 'PNG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
  'image/svg+xml': 'SVG image',
  'image/heic': 'HEIC image',
  'video/mp4': 'MP4 video',
  'video/quicktime': 'QuickTime video',
  'video/webm': 'WebM video',
  'audio/mpeg': 'MP3 audio',
  'audio/mp4': 'M4A audio',
  'audio/wav': 'WAV audio',
  'audio/x-wav': 'WAV audio',
  'audio/ogg': 'Ogg audio',
  'application/pdf': 'PDF',
  'text/html': 'Web page',
  'text/plain': 'Plain text',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'text/css': 'CSS',
  'application/json': 'JSON',
  'application/xml': 'XML',
  'text/xml': 'XML',
  'application/javascript': 'JavaScript',
  'text/javascript': 'JavaScript',
  'application/zip': 'ZIP archive',
  'application/x-zip-compressed': 'ZIP archive',
  'application/gzip': 'Gzip archive',
  'application/x-tar': 'TAR archive',
  'application/x-7z-compressed': '7-Zip archive',
  'application/vnd.rar': 'RAR archive',
  'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.ms-excel': 'Excel spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
  'application/vnd.ms-powerpoint': 'PowerPoint deck',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint deck',
  'application/epub+zip': 'EPUB book',
  'application/x.arweave-manifest+json': 'Arweave manifest',
};
const FAMILY: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  font: 'Font',
  model: '3D model',
};
const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * A file's type in words: from its MIME type, else from its name's extension
 * when the type says nothing (none, or application/octet-stream); "File"
 * when neither does.
 */
export function fileType(mime: string | null | undefined, name?: string | null): string {
  let t = (mime || '').toLowerCase().split(';')[0]!.trim();
  if (!t || t === 'application/octet-stream') {
    const ext = /\.([a-z0-9]{1,5})$/.exec((name || '').toLowerCase())?.[1];
    t = (ext && BY_EXTENSION[ext]) || t;
  }
  if (NAMED[t]) return NAMED[t]!;
  const family = FAMILY[t.split('/')[0]!];
  return family ?? (t && t !== 'application/octet-stream' ? t : 'File');
}
