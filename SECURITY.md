# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then
**Report a vulnerability**. Please don't open a public issue. Say what is
affected, how to reproduce it, and what an attacker gains.

## What is in scope

These pages promise that nothing from an index is used before it is
verified. A way around any of these checks is a vulnerability:

- the publication's Ed25519 signature, and its key's lookup in the ar.io
  gateway registry through a different gateway
  (`packages/index-client/src/publication.ts`);
- the range reader's check of every piece against the BitTorrent v2 hash tree
  the signed publication pins (`packages/index-client/src/range/`);
- the SHA-256 pins on the DuckDB-WASM engine and its worker
  (`engine.lock.json`);
- the size check and the "not covered by the signature" label on names taken
  from ArDrive record JSON;
- the release gate: a deploy that ships bytes other than the ones
  `scripts/release.mjs verify` recorded.

The index formats and the gateways that publish them are maintained in
[ar-io/ar-io-node](https://github.com/ar-io/ar-io-node); report problems with
them there.
