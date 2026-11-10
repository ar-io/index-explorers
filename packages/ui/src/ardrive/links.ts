/**
 * Links into the ArDrive app, which opens a public drive, folder or file for
 * anyone, signed in or not (app.ardrive.io: #/drives/<id>,
 * #/drives/<id>/folders/<id>, #/file/<id>/view). A private one needs its key,
 * which a page that only reads the index never has: null.
 */
export interface ArDriveTarget {
  driveId: string;
  privacy: 'public' | 'private';
  folderId?: string | null;
  fileId?: string | null;
}

export function ardriveUrl(t: ArDriveTarget, appUrl = 'https://app.ardrive.io'): string | null {
  if (t.privacy === 'private') return null;
  const base = `${appUrl.replace(/\/+$/, '')}/#`;
  if (t.fileId) return `${base}/file/${t.fileId}/view`;
  if (t.folderId) return `${base}/drives/${t.driveId}/folders/${t.folderId}`;
  return `${base}/drives/${t.driveId}`;
}
