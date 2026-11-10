# ArDrive Explorer

Every drive, folder and file on ArDrive, over the gateway-signed `ardrive-l2` index, verified in the browser. Live at https://explore_ardrive.ar.io.

`src/session.ts` owns the engine, the range reader and the verified bands; `src/store.ts` is the one store; `src/data/` holds the flows (browse, drive, wallet, find, query); `src/model/` the pure models (`arfs.ts`: records → tree; `names.ts`: the record pool; `rows.ts`: Arrow → records); `src/views/` the Preact views: `App.tsx` is the app shell, as ArDrive web's (`TopBar.tsx` with Find and the Verified chip, `SideNav.tsx`), and `Sections.tsx` draws one view per nav section (Drives, Questions, SQL, Data source), each a history entry in the URL fragment (`src/router.ts`). Build-time `VITE_*` variables point an E2E build at the local fixture gateway (`pnpm run build:e2e`); production defaults are in `src/config.ts`.

Run it: `pnpm run dev`, then open http://localhost:5173/#gw=https://turbo-gateway.com. Tests: `pnpm test` (models) and, from the repo root, `pnpm e2e` (matrix, navigation, stress).
