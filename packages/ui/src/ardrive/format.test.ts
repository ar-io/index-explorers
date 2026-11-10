import { describe, expect, it } from 'vitest';

import { dateText, dateTimeText, fileType, sizeText } from './format.js';

describe('ArDrive formats', () => {
  it('writes a day for lists and the time for details, in UTC', () => {
    const ms = Date.UTC(2026, 9, 13, 8, 4);
    expect(dateText(ms)).toMatch(/Oct\w* 13,? 2026|13 Oct\w* 2026/);
    expect(dateTimeText(ms)).toMatch(/08:04 UTC$/);
    expect(dateText(null)).toBe('');
    expect(dateText(0)).toBe('');
  });
  it('scales a size to its unit', () => {
    expect(sizeText(108)).toBe('108 B');
    expect(sizeText(16179)).toBe('15.8 KB');
    expect(sizeText(7.34 * 2 ** 30)).toBe('7.34 GB');
    expect(sizeText(null)).toBe('');
  });
  it('names a type in words, from the name when the type says nothing', () => {
    expect(fileType('audio/mpeg')).toBe('MP3 audio');
    expect(fileType('text/html; charset=utf-8')).toBe('Web page');
    expect(fileType('application/octet-stream', 'scan.pdf')).toBe('PDF');
    expect(fileType('image/x-icon')).toBe('Image');
    expect(fileType('application/octet-stream')).toBe('File');
    expect(fileType(null, 'notes')).toBe('File');
    expect(fileType('application/x-custom')).toBe('application/x-custom');
  });
});
