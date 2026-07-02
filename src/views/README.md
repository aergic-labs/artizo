# src/views/

Tree view providers for VS Code's built-in Remote Explorer panel.

Not wired up. `ContainerExplorerProvider`, `DetailsViewProvider`,
`VolumesViewProvider`, and `PortViewProvider` all have `.register()`
methods but none are called from `extension.ts`.

`package.json` declares `artizo.detailsView` and `artizo.portsView` as
views under the `remote` container, but without a registered provider
they render empty or are suppressed.
