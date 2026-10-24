# Arweave L1 Index Explorer

SQL and lookups over every base-layer transaction since 2018, over the `parquet-l1` index, verified in the browser. Live at https://arweave-l1-search.ar.io.

`src/session.ts` owns the publication, the periods (windows built from band edges), the engine with the window's views (`parquetL1.l1PeriodSql`) and Find through the lookup files; `src/questions.ts` the questions and presets; `src/views/App.tsx` the page. `pnpm run dev`, then http://localhost:5173/#gw=https://turbo-gateway.com.
