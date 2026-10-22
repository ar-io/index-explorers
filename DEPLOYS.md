# Deploys

Every upload, newest first. The manifest id is what the ArNS name points at. Each entry lists the SHA-256 of every uploaded file, so a rebuild of the same commit can be compared with what is live.

## 2026-10-21 · arweave-l1-explorer 1.0.0

- manifest: `HK9Uy7kJj5BC_AlLA5TWDBHi78YBIE8NgY2x5OmWdk8`
- name: https://arweave-l1-search.ar.io
- before: `Q0ZNscHPO0yAYRGrGj242nkTE8kPQ6ttlKP52zd8Vj4` (point the record back at it to roll back)
- commit: 93fadb2
- files:
  - `assets/arrow-C6ch5XQ7.js` be8bc38f3801bd076186c30711cd432a3dcd9b7763d980467fd1ca79dfdc4e07
  - `assets/arrow-C6ch5XQ7.js.map` 77dad6f3bf94ab9bc509b483ef2a295b7dc1946d4415b8ed0add2fc36f00305d
  - `assets/duckdb-DEFjrUmw.js` bc4eb1da21fc7900919b875b67f16e65c313fcd8fbb3398ccf8fd3aaaba088b2
  - `assets/duckdb-DEFjrUmw.js.map` d64e370a5a8956c045a4777168055b682f512a49ee68abc36f169c7c788e094c
  - `assets/index-Bng1ROBM.css` ed4065492b79e089f630a55b97654f246d4725e48069822d637ee5830ba34365
  - `assets/index-DWKgkFa8.js` 744bd37a241900881c392d277779fc553017aa412d37c0a1d46a9649d0c5d456
  - `assets/index-DWKgkFa8.js.map` b58bf32529782d6111ea8b2983986588e660042fe8f082e9934c6edc9f63db03
  - `index.html` ad0127afc9b7cfe7749a6549f4544a595977f7f48cd4421322a6b1efaf54868c
  - `sw.js` 7ff215948cf1d6c6945146bbc2ab28d2a4c7c3d8ccd9555eb7e748c89131e4c2

## 2026-10-22 · network-index rolled back to v0

- cdb64.ar.io `@` set back to `oh8viBLoGvvhpiopGZ08jIORh63WKAFGSrHiDgxncdg` (the original page) with `ar.io set-ant-base-name`, signed by the arweave environment's controller key. Solana transaction `3H8VvxUWnAUyDxrt2RvbBEyNLCEoiB8hUDNyEocowBvSEymGhnYLXhj1VYaGKyXDeoDN9aw9AH7HdPoUTgT6eVgo`.
- Why: 1.0.0 searched only the published root-tx bands (about 169 million records from block 700,000) and missed most items the original page found in its Arweave packs (3.84 billion to block 1,820,000), and it dropped the original's links, item check, preview, copy and example. A feature-by-feature audit found the gaps; 1.1.0 restores them.
- Every node served the original page on 12 plain GETs in a row 338 s after the update.

## 2026-10-21 · network-index 1.0.0

- manifest: `LH5q2GKIg4-I0-EWI0laW7tst70mJ3jheUcoCU4d33s`
- name: https://cdb64.ar.io
- before: `oh8viBLoGvvhpiopGZ08jIORh63WKAFGSrHiDgxncdg` (point the record back at it to roll back)
- commit: 93fadb2
- files:
  - `assets/arrow-BrJ3Opv-.js` d7c8e02c630324ecd288c24015c22148fdf865e3b6283bc859130c7460a28ee2
  - `assets/arrow-BrJ3Opv-.js.map` 6d4717757ed96fb91b478245209d36df96d4e2283b5cdfbe2dfd0680a53e6f45
  - `assets/duckdb-B2AE9Fkb.js` 6f663b308aacb914cd086a9aed42d10ec6007a6bb162d4bd0a271b776b88044e
  - `assets/duckdb-B2AE9Fkb.js.map` d53a683be4a3d5726ab48a2f431c11f65a5ca04cb52adecf32319b44788f7583
  - `assets/index-BwAXxTuk.js` fa2bcefcabc8386b27f9bd17f9d8a0a89dad7af2ddfaa0a5927fa27ef020ac66
  - `assets/index-BwAXxTuk.js.map` 271c2bea97ffb755714beb8970e98ea39cbf1551edc15fd3a843837432e917b5
  - `assets/index-DGuB3sLL.css` 510495adfee0f5357424437deac413ec666d0453f5b83abc189fdb2b12a6b732
  - `index.html` 48066b2b62b980ee4e5aac97789d5c60b5b8d09ec0e9605383fa80fe323378b6
  - `sw.js` 7ff215948cf1d6c6945146bbc2ab28d2a4c7c3d8ccd9555eb7e748c89131e4c2

