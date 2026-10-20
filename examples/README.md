# Examples

Standalone uses of `@ar-io/index-client`, runnable from a checkout.

- `lookup-root.ts`: verify turbo-gateway.com's publication against the registry, fetch and check a root-tx band's torrent, and resolve a data item to its root transaction with range reads checked piece by piece, all in Node:

  ```bash
  pnpm example:lookup 4aCplvNxtUx2DnpUUhhGkecFXiUDJFYhZDlra8ClGXA
  ```

The apps themselves are the browser examples; `apps/network-index` is the smallest.
