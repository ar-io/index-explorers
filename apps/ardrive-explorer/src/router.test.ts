import { describe, expect, it } from 'vitest';

import { encodeFragment, parseFragment } from './router.js';

describe('fragment round trips', () => {
  it('encodes and parses every view kind', () => {
    const cases = [
      { kind: 'home' as const },
      { kind: 'browse' as const },
      { kind: 'drive' as const, key: '05b211dd-ae1e-44ef-b055-2e102933e4e8', folder: null },
      {
        kind: 'drive' as const,
        key: '05b211dd-ae1e-44ef-b055-2e102933e4e8',
        folder: 'b017f1f8-1974-4cbd-b8da-e16a30b218bf',
      },
      { kind: 'wallet' as const, key: 'dBRMGwLFzqr7V6CSNU6ZwcrDfDI20Y1vdZfpBQINbNU' },
      { kind: 'id' as const, key: '4aCplvNxtUx2DnpUUhhGkecFXiUDJFYhZDlra8ClGXA' },
      { kind: 'query' as const, sql: "SELECT 1 FROM drives WHERE x = 'a b'" },
    ];
    for (const view of cases) {
      const frag = encodeFragment({ gw: 'https://turbo-gateway.com', period: 'month', view });
      const back = parseFragment(frag);
      expect(back.gw).toBe('https://turbo-gateway.com');
      expect(back.period).toBe('month');
      expect(back.view).toEqual(view);
    }
  });

  it('upper-cases nothing but lower-cases a drive id, and treats an empty fragment as no link', () => {
    expect(parseFragment('#drive=05B211DD-AE1E-44EF-B055-2E102933E4E8').view).toEqual({
      kind: 'drive',
      key: '05b211dd-ae1e-44ef-b055-2e102933e4e8',
      folder: null,
    });
    expect(parseFragment('')).toEqual({ gw: null, period: null, view: null });
    expect(parseFragment('#period=week').view).toEqual({ kind: 'home' });
    expect(parseFragment('#browse').view).toEqual({ kind: 'browse' });
    expect(parseFragment('#period=week&browse').view).toEqual({ kind: 'browse' });
    expect(encodeFragment({ gw: null, period: 'week', view: { kind: 'browse' } })).toBe(
      '#period=week&browse',
    );
  });
});
