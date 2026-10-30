# @ar-io/explorer-ui

Design tokens, the shared page chassis and a few primitives for the index explorers.

- `ardrive-tokens.css`: the ArDrive design system's tokens ([ardrive.io/brand-kit/design-system.md](https://ardrive.io/brand-kit/design-system.md)): its theme colours for dark (the default) and light (from `prefers-color-scheme` or `data-theme`), type scale, spacing, radii, button and field heights, and the table and menu surfaces. It also serves Roboto Mono (SIL Open Font License) for IDs and code. Wavehaus is licensed and is not in this repository, so text uses the system's fallback stack. The ArDrive explorer imports this and its own stylesheet, and nothing else here.
- `tokens.css` with `base.css`, and `ario.css` over them: the ar.io pages (the network index and the L1 explorer). Their chassis has a framed masthead, panels, controls, tables, the trust line (`.proof`, `.checks`), progress, drawers and a footer. `data-brand="ario"` switches to ar.io's colours, Besley and Plus Jakarta Sans (both SIL Open Font License).
- Components (Preact):
  - `Proof`: the one-line trust summary, with the four checks behind it.
  - `ProgressBar`.
  - `Icon`, `iconFor` and `typeLabel`.
  - `Badge` and `OwnerDot`.
  - `Select` and `ActionMenu`: the design system's menus, drawn by the page rather than the browser, with its keyboard behaviour. `AnchoredMenu` is one action menu shared by the rows of a long list.
  - `useWindowed`: renders N rows, then more as a sentinel scrolls into view.

Import the CSS in your entry (for an ar.io page `@ar-io/explorer-ui/tokens.css`, then `base.css`, then `ario.css`) and the components from the package root. See `apps/network-index` for the smallest page built on it.
