import { describe, expect, it } from 'vitest';

import {
  fetchPublication,
  lookupRegistry,
  parsePublication,
  selectIndex,
  signingBase,
  tipOf,
  verifyPublication,
  verifySignature,
  type Publication,
} from '../src/index.js';
import {
  fakeFetch,
  GATEWAY,
  LIVE_PEERS,
  LIVE_PUBLICATION,
  PUBLISHER,
  readJson,
} from './helpers.js';

const raw = readJson(LIVE_PUBLICATION) as Record<string, unknown>;
const peers = readJson(LIVE_PEERS);
const clone = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
const registry = {
  wallet: PUBLISHER,
  observerAddress: PUBLISHER,
  url: GATEWAY,
  via: 'https://vilenarios.com',
};

describe('parsePublication', () => {
  it('accepts the recorded publication and keeps its shape', () => {
    const doc = parsePublication(raw);
    expect(doc.version).toBe(1);
    expect(doc.publisher).toBe(PUBLISHER);
    expect(doc.sequence).toBe(159);
    expect(doc.indexes.map((i) => [i.name, i.kind, i.bands.length])).toEqual([
      ['root-tx-index', 'cdb64-root-tx', 17],
      ['parquet-l1', 'parquet-l1', 25],
      ['ardrive-l2', 'parquet-l2', 25],
    ]);
  });

  it('refuses a wrong version, a bad digest, a reserved name and an oversize band', () => {
    const v = clone();
    v.version = 2;
    expect(() => parsePublication(v)).toThrow(/version/);
    const d = clone();
    (d.indexes as { bands: { files: { sha256: string }[] }[] }[])[0]!.bands[0]!.files[0]!.sha256 =
      'zz';
    expect(() => parsePublication(d)).toThrow(/sha256/);
    const n = clone();
    (n.indexes as { name: string }[])[0]!.name = '__proto__';
    expect(() => parsePublication(n)).toThrow(/index name/);
    const b = clone();
    (b.indexes as { bands: { id: string }[] }[])[0]!.bands[0]!.id = '../etc';
    expect(() => parsePublication(b)).toThrow(/band id/);
  });
});

describe('signature', () => {
  it('verifies the recorded publication against the registry key', async () => {
    const doc = parsePublication(raw);
    await expect(verifySignature(doc, PUBLISHER)).resolves.toBeUndefined();
  });

  it('refuses a tampered band digest: the digests live inside the signed document', async () => {
    const t = clone();
    const file = (t.indexes as { bands: { files: { sha256: string }[] }[] }[])[2]!.bands[3]!
      .files[1]!;
    file.sha256 = file.sha256.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    await expect(verifySignature(parsePublication(t), PUBLISHER)).rejects.toThrow(/does not match/);
  });

  it('refuses a changed sequence, a dropped band and an added unknown field', async () => {
    const s = clone();
    s.sequence = 160;
    await expect(verifySignature(parsePublication(s), PUBLISHER)).rejects.toThrow(/does not match/);
    const d = clone();
    (d.indexes as { bands: unknown[] }[])[2]!.bands.pop();
    await expect(verifySignature(parsePublication(d), PUBLISHER)).rejects.toThrow(/does not match/);
    // Unknown fields are part of what is signed: adding one changes the base.
    const u = clone();
    u.note = 'hello';
    await expect(verifySignature(parsePublication(u), PUBLISHER)).rejects.toThrow(/does not match/);
  });

  it('refuses a key the registry does not name, a wrong alg and a short signature', async () => {
    const doc = parsePublication(raw);
    await expect(
      verifySignature(doc, 'HpHVKAvQTwMBHm4qEdHBbKgjsBBdwKC1YetKzdMKuWpt'),
    ).rejects.toThrow(/registry names/);
    const a = parsePublication({
      ...clone(),
      signature: { ...(raw.signature as object), alg: 'rsa' },
    });
    await expect(verifySignature(a, PUBLISHER)).rejects.toThrow(/not Ed25519/);
    const sig = raw.signature as { sig: string; keyId: string };
    const sh = parsePublication({
      ...clone(),
      signature: { alg: 'ed25519', keyId: sig.keyId, sig: sig.sig.slice(0, 20) },
    });
    await expect(verifySignature(sh, PUBLISHER)).rejects.toThrow(/64 bytes/);
  });

  it('builds the signing base with the fixed prefix and canonical JSON', () => {
    const doc = parsePublication(raw);
    const base = new TextDecoder().decode(signingBase(doc));
    expect(base.startsWith('ar-io-index-publication/v1\n{"expiresAt":"')).toBe(true);
    expect(base).not.toContain('"signature"');
  });
});

describe('registry and verifyPublication', () => {
  it('reads the publisher record from an independent gateway and never from the data gateway', async () => {
    const fetchImpl = fakeFetch({
      'https://vilenarios.com/ar-io/peers': JSON.stringify(peers),
      'https://turbo-gateway.com/ar-io/peers': JSON.stringify({ gateways: {} }),
    });
    const rec = await lookupRegistry(PUBLISHER, {
      gateways: ['https://turbo-gateway.com', 'https://vilenarios.com'],
      excluding: GATEWAY,
      fetch: fetchImpl,
    });
    expect(rec.observerAddress).toBe(PUBLISHER);
    expect(rec.via).toBe('https://vilenarios.com');
    expect(rec.url).toBe(GATEWAY);
    await expect(
      lookupRegistry(PUBLISHER, {
        gateways: ['https://turbo-gateway.com'],
        excluding: GATEWAY,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/no independent gateway/);
    await expect(
      lookupRegistry('nobody', { gateways: ['https://vilenarios.com'], fetch: fetchImpl }),
    ).rejects.toThrow(/not in the registry/);
  });

  it('passes the recorded publication and reports the checks in order', async () => {
    const doc = parsePublication(raw);
    const seen: string[] = [];
    const proof = await verifyPublication(doc, {
      registryGateways: ['https://vilenarios.com'],
      registry,
      onCheck: (c, s) => seen.push(`${c}:${s}`),
      now: () => Date.parse('2026-10-20T13:00:00Z'),
    });
    expect(seen).toEqual(['registry:run', 'registry:ok', 'signature:run', 'signature:ok']);
    expect(proof.key).toBe(PUBLISHER);
    expect(proof.expired).toBe(false);
    expect(proof.publisherUrl).toBe(GATEWAY);
    const later = await verifyPublication(doc, {
      registryGateways: [],
      registry,
      now: () => Date.parse('2026-10-22T00:00:00Z'),
    });
    expect(later.expired).toBe(true);
  });

  it('marks the failing check bad and throws', async () => {
    const doc = parsePublication(raw);
    const seen: string[] = [];
    await expect(
      verifyPublication(doc, {
        registryGateways: ['https://vilenarios.com'],
        registry: { ...registry, observerAddress: 'HpHVKAvQTwMBHm4qEdHBbKgjsBBdwKC1YetKzdMKuWpt' },
        onCheck: (c, s) => seen.push(`${c}:${s}`),
      }),
    ).rejects.toThrow(/registry names/);
    expect(seen.at(-1)).toBe('signature:bad');
  });

  it('fetchPublication bounds, parses and hashes the document', async () => {
    const text = JSON.stringify(raw);
    const got = await fetchPublication(GATEWAY, {
      fetch: fakeFetch({ 'https://turbo-gateway.com/ar-io/indexes': text }),
    });
    expect(got.doc.sequence).toBe(159);
    expect(got.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      fetchPublication(GATEWAY, {
        fetch: fakeFetch({ 'https://turbo-gateway.com/ar-io/indexes': 'not json' }),
      }),
    ).rejects.toThrow(/not JSON/);
    await expect(
      fetchPublication('https://nowhere.example', { fetch: fakeFetch({}) }),
    ).rejects.toThrow(/404/);
  });
});

describe('selectIndex', () => {
  const doc: Publication = parsePublication(raw);

  it('drops empty parquet bands, sorts by height, and resolves URLs and torrents', () => {
    const ix = selectIndex(doc, 'ardrive-l2', {
      gateway: GATEWAY,
      mirrors: ['https://vilenarios.com'],
    });
    expect(ix.kind).toBe('parquet-l2');
    expect(ix.bands.length).toBe(18);
    expect(ix.dropped.filter((d) => d.why === 'no records').length).toBe(7);
    expect(ix.bands.map((b) => b.from)).toEqual(
      [...ix.bands.map((b) => b.from)].sort((a, b) => a - b),
    );
    const b = ix.bands.find((x) => x.id.startsWith('l2-h700000'))!;
    expect(b.records).toBe(2712);
    expect(b.files.get('tags.parquet')?.url).toBe(
      'https://turbo-gateway.com/ar-io/indexes/ardrive-l2/l2-h700000-799999-3078e8b8-a2a34f51df49/tags.parquet',
    );
    expect(b.torrent?.infohashV2).toBe(
      'fe8c79aebba7ff9b92bd75133e51084b198f982f7d0d11bf922abc10b6a7f49c',
    );
    expect(b.torrent?.urls).toEqual([
      'https://turbo-gateway.com/ar-io/indexes/torrents/43f7de78570542926d82e9e37c45b014409c14f1.torrent',
      'https://vilenarios.com/ar-io/indexes/torrents/43f7de78570542926d82e9e37c45b014409c14f1.torrent',
    ]);
    expect(b.schema).toBe('l2-1');
    expect(tipOf(ix.bands)).toBe(2024964);
  });

  it('keeps every cdb64 band, overlaps included, and knows an open tip', () => {
    const ix = selectIndex(doc, 'root-tx-index', { gateway: GATEWAY });
    expect(ix.bands.length).toBe(17);
    const tip = ix.bands[ix.bands.length - 1]!;
    expect(tip.to).toBeNull();
    expect(tipOf(ix.bands)).toBeNull();
    expect(tip.files.size).toBe(257);
  });

  it('prunes a band inside another and a superseded one', () => {
    const d = JSON.parse(JSON.stringify(raw)) as {
      indexes: { name: string; bands: Record<string, unknown>[] }[];
    };
    const l1 = d.indexes.find((i) => i.name === 'parquet-l1')!;
    const inner = JSON.parse(
      JSON.stringify(l1.bands.find((b) => (b.id as string).startsWith('l1-h2000000'))!),
    ) as Record<string, unknown>;
    inner.id = 'l1-h2000000-2001999-x';
    inner.heightRange = [2000000, 2001999];
    l1.bands.push(inner);
    const old = JSON.parse(JSON.stringify(l1.bands[0]!)) as Record<string, unknown>;
    old.id = 'l1-h0-99999-3078e8b8-8b85745f2fdb'; // named in the first band's metadata.supersedes
    l1.bands.push(old);
    const ix = selectIndex(parsePublication(d), 'parquet-l1', { gateway: GATEWAY });
    expect(ix.bands.length).toBe(25);
    expect(ix.dropped.map((x) => x.why).sort()).toEqual([
      'inside l1-h2000000-2004999-3078e8b8-8c27d55aa838',
      'superseded',
    ]);
  });

  it('throws for an index the publication does not list', () => {
    expect(() => selectIndex(doc, 'nope', { gateway: GATEWAY })).toThrow(/publishes no nope/);
  });
});
