# ar.io network index

Every index a gateway publishes, verified: bands, sizes, digests, torrents, freshness, the commands to run a copy, and a CDB64 lookup of a data item's root transaction through verified range reads. Replaces the static cdb64.ar.io page.

`src/session.ts` reads and verifies the publication and runs the lookup (`cdb64.lookupRoot` with a reader that fetches through the service worker, so every byte is checked against the band's torrent); `src/views/App.tsx` is the page. The smallest of the three apps: start here to see how the client is used. `pnpm run dev`, then http://localhost:5173/#gw=https://turbo-gateway.com.
