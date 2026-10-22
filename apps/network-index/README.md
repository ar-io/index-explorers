# cdb64.ar.io: the CDB64 root transaction index

Which Arweave transaction holds a data item, looked up in the browser, plus every index the gateway publishes, verified. It keeps everything the original cdb64.ar.io page did and adds the signed publication.

**Where a lookup searches, first answer wins:**

1. The root-tx bands the gateway's signed publication lists above block 1,820,000, read through the service worker so every byte is checked against the band's torrent. This runs at the same time as step 2.
2. The three root-tx packs on Arweave that cdb64.ar.io has always read: AO, non-AO with Content-Type, non-AO without, 3,835,961,527 items to block 1,820,000 in 180 transactions. The table of where each partition starts is `src/data/packs.json`, taken from the original page. No publication signs these, so they are plain range reads.
3. The remaining published bands, if neither answered.

**Every hit is then checked against the data, as the original page did.** The page compares the gateway's own `x-ar-io-root-transaction-id`. It then reads the item's signature at its offset in the root transaction and confirms its SHA-256 is the id. That confirms where the item sits, not the signature itself.

**Links:** old `#<id>` links still run the lookup, and so do `#gw=…&id=…` links.

**Without a service worker**, for example after a hard reload, lookups use the packs only.

**Code:** `src/session.ts` reads and verifies the publication and runs the lookup, using `cdb64.lookupRoot`, `cdb64.lookupPacks` and `cdb64.checkItemAtOffset` from the client. `src/views/App.tsx` is the page.

**Run it:** `pnpm run dev`, then open http://localhost:5173/#gw=https://turbo-gateway.com. The E2E build reads Arweave data from the fixture gateway, set by `VITE_ARWEAVE_GATEWAYS`.
