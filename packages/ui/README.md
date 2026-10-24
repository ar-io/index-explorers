# @ar-io/explorer-ui

Design tokens, the shared page chassis and a few primitives for the index explorers.

- `tokens.css`: ArDrive's brand (Onyx `#121212`, Alabaster `#FAFAFA`, Primary `#D31721`) as CSS variables, dark by default with a light theme from `prefers-color-scheme` or `data-theme="light"`; `data-brand="ario"` on the root switches to ar.io's colours.
- `base.css`: the framed masthead, panels, controls, tables, the trust line (`.proof`, `.checks`), progress, drawers and footer.
- `fonts/plus-jakarta-sans.css`: Plus Jakarta Sans (SIL Open Font License), the face both brands use here. ArDrive's own face, Wavehaus, may not be redistributed, so it is not in this repository.
- Components (Preact): `Proof` (the one-line trust summary with the four checks behind it), `ProgressBar`, `Icon`/`iconFor`/`typeLabel`, `Badge`, `OwnerDot`, and `useWindowed` (render N rows, more as a sentinel scrolls into view).

Import the CSS in your entry (`@ar-io/explorer-ui/tokens.css`, then `base.css`) and the components from the package root. See `apps/network-index` for the smallest page built on it.
