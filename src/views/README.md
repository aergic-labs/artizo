# src/views/

Tree view providers for VS Code's built-in Remote Explorer panel.

## Wired

- `ContainerExplorerProvider` (`containerExplorer.ts`) - registered from
  `host/services.ts` `createServices()`. Registers the `artizo.explorer`
  tree view plus per-item commands: connect (current/new window),
  stop/start/remove, show logs, inspect/remove volume, clone in volume.

## Unwired (retained, not registered)

- `DetailsViewProvider` (`detailsView.ts`) - superseded by the sidebar
  webview. Class and tests kept, `register()` not called.
- `VolumesViewProvider` (`volumesView.ts`) - folded into
  `ContainerExplorerProvider` as the "Volumes" category. Class and tests
  kept, `register()` not called.

## Elsewhere

- `PortViewProvider` (`ports/portView.ts`) - wired from `services.ts`.
