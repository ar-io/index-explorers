# Deploys

Every upload, newest first. The manifest id is what the ArNS name points at. Each entry lists the SHA-256 of every uploaded file, so a rebuild of the same commit can be compared with what is live. Entries are written by `scripts/record-deploy.mjs` from the Deploy workflow; nothing deploys from a developer machine.

No deploys yet. What the names point at now, checked 2026-10-20, so a first deploy can be undone:

| name | record | points at | controlled by |
| --- | --- | --- | --- |
| `cdb64.ar.io` | `@` of `cdb64` (lease, ends 2027-10-03) | `oh8viBLoGvvhpiopGZ08jIORh63WKAFGSrHiDgxncdg`, the v0 landing page | `2DXykUor86ZNK2Wfy9VVWFmQdvwRx8eteu1jJFPDrqeV` |
| `arweave-l1-search.ar.io` | `@` of `arweave-l1-search` (permabuy) | `Q0ZNscHPO0yAYRGrGj242nkTE8kPQ6ttlKP52zd8Vj4`, the v0 L1 page | `2DXykUor86ZNK2Wfy9VVWFmQdvwRx8eteu1jJFPDrqeV` |
| `explore_ardrive.ar.io` | `explore` of `ardrive` | nothing: the undername does not exist yet (404) | `CUweBonZX6VGHqNM1RDP7AtjTKg7hcsn2VXtsJeempst` (owner `6eV7bK3bQJdd7Q44doWqAbnBCWNQRhB1HwCDGWf8Qe3V`) |

Deploys sign with keys made for this repository: the `arweave` environment's ArNS key is `2EzGpd5ZyyGz8mq9kTMdnzcG1uHevp26nb1GMsfcKDHH`, the `ardrive` environment's `28aWqmK1tNyC7apxxPNU1jSy4PWAVzpCzwnWA6gdxrs4`, each added as a controller of its names.

The ArDrive Explorer v0 was never put behind a name. Its last upload,
`OqTG2XFz3ohTuwWVQt1Aevs4wi-6zvfOy1YB6ooYvkU`, is reachable only by id.
