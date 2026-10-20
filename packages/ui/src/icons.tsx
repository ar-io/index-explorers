/** Inline icons, one path each, drawn in currentColor. */
const PATHS = {
  folder:
    'M3 6.5A2.5 2.5 0 0 1 5.5 4h3.9c.6 0 1.2.2 1.6.6L12.6 6H18.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z',
  drive:
    'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v4H4v-4Zm0 6.5h16v4.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5V12Zm12 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  image:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 13.2V18h14v-4.6l-3.4-3.4a1 1 0 0 0-1.4 0L9.5 14.7l-2.1-2.1a1 1 0 0 0-1.4 0L5 13.6v3.6ZM8 7.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Z',
  video:
    'M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 17.5v-11Zm13 3.2 3.1-2.1a.6.6 0 0 1 .9.5v7.8a.6.6 0 0 1-.9.5L17 14.3V9.7Z',
  audio:
    'M14 3.5v11.1a3.5 3.5 0 1 1-2-3.2V6.2L7 7.6v8.6a3.5 3.5 0 1 1-2-3.2V6.1a1.5 1.5 0 0 1 1.1-1.4l6.4-1.9A1.2 1.2 0 0 1 14 3.5Z',
  doc: 'M6 3h7.2L19 8.8V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 1.8V9h4.2L13 4.8ZM8 12h8v1.6H8V12Zm0 3.4h8V17H8v-1.6Z',
  archive:
    'M5 3h14a1 1 0 0 1 1 1v3H4V4a1 1 0 0 1 1-1Zm-1 6h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9Zm6 2v1.5h4V11h-4Zm0 3v1.5h4V14h-4Z',
  code: 'm8.6 7.4-4.3 4.6 4.3 4.6 1.5-1.4-3-3.2 3-3.2-1.5-1.4Zm6.8 0-1.5 1.4 3 3.2-3 3.2 1.5 1.4 4.3-4.6-4.3-4.6Z',
  file: 'M6 3h7.2L19 8.8V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 1.8V9h4.2L13 4.8Z',
  lock: 'M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H7Zm2 0h6V8a3 3 0 0 0-6 0v2Z',
  up: 'M12 5.5 5 12.5l1.4 1.4 4.6-4.6V19h2v-9.7l4.6 4.6 1.4-1.4-7-7Z',
  wallet:
    'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v1h-2V7a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1h2v1a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Zm9 3h8v4h-8a2 2 0 1 1 0-4Zm1 1.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
} as const;

export type IconName = keyof typeof PATHS;
export const ICONS = PATHS;

export function Icon({ name, big = false }: { name: IconName; big?: boolean }) {
  return (
    <span class={`ico ico-${name}${big ? ' big' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d={PATHS[name] ?? PATHS.file} />
      </svg>
    </span>
  );
}

/** Which icon a file gets, from its content type, else its name. */
export function iconFor(type: string | null | undefined, name: string | null | undefined): IconName {
  const t = (type || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (/zip|rar|7z|tar|gzip|compressed|x-iso|diskimage/.test(t) || /\.(zip|rar|7z|tar|gz|tgz|iso|dmg)$/.test(n)) return 'archive';
  if (
    /javascript|json|xml|html|css|x-sh|typescript|yaml|python/.test(t) ||
    /\.(js|ts|json|xml|html?|css|sh|py|yml|yaml|md|sql)$/.test(n)
  )
    return 'code';
  if (/pdf|msword|officedocument|text\/|epub|rtf/.test(t) || /\.(pdf|docx?|xlsx?|pptx?|txt|csv|epub)$/.test(n)) return 'doc';
  return 'file';
}

const KIND_LABEL: Record<IconName, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  code: 'code',
  doc: 'document',
  file: 'file',
  folder: 'folder',
  drive: 'drive',
  lock: 'encrypted',
  up: '',
  wallet: 'wallet',
};

/** A short type label for a list: the subtype of a content type, or the icon's kind. */
export function typeLabel(type: string | null | undefined, name: string | null | undefined): string {
  if (type && type !== 'application/octet-stream')
    return type.split('/').pop()!.replace(/^x-/, '').replace(/^vnd\./, '').slice(0, 24);
  return KIND_LABEL[iconFor(type, name)];
}
