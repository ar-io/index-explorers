import { describe, expect, it } from 'vitest';

import { ardriveUrl } from './links.js';

describe('ardriveUrl', () => {
  it('links a public drive, folder and file, and nothing private', () => {
    const d = { driveId: 'd1', privacy: 'public' as const };
    expect(ardriveUrl(d)).toBe('https://app.ardrive.io/#/drives/d1');
    expect(ardriveUrl({ ...d, folderId: 'f1' })).toBe(
      'https://app.ardrive.io/#/drives/d1/folders/f1',
    );
    expect(ardriveUrl({ ...d, fileId: 'x1' }, 'https://app.example/')).toBe(
      'https://app.example/#/file/x1/view',
    );
    expect(ardriveUrl({ ...d, privacy: 'private' })).toBeNull();
  });
});
