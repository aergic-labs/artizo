# Changelog

## 0.7.0

### Added

- "Reopen in Container (New Window)" command (`><` menu and sidebar).
- Recent folders in the Remote Explorer, grouped per container authority, with a working Forget context menu.
- `remoteUser` saved as docker label `artizo.remote_user` at build; restored on re-attach so install/start run as the right user instead of root.
- `containerUser` read from `docker inspect` `Config.User` as fallback when `remoteUser` is absent or missing in the image.
- `preflightRemoteUser` validates via `getent passwd` and caches per container.
- `isValidDockerUser` rejects argument injection before `docker exec -u`.
- `remoteUser`/`containerUser` threaded through `gitConfigCopier`, `serverManager`, and `bootstrap`.
- `src/utils/tar.ts` factored out of `bootstrap.ts`; used to stream extension installs as `remoteUser`.
- `folderHistory.ts` (and test) shared from zygos via `make sync-shared`.

### Changed

- `><` menu: "Return to Host" moved to end of section (just before "Close Remote Connection").
- `><` menu: removed "Clean Up Dev Containers", "Open Folder in Container", and "Open Folder in Container (New Window)".
- `removeRecentFolder` → `forgetFolder` (title "Forget").
- Recent folder groups labeled by workspace basename; attached containers show "Container <short-id>".
- Folder history tree auto-refreshes via `FolderHistoryManager.onDidChange`.
- README template system restored: `{{section:name}}` placeholders flow from `BEGIN/END` blocks in README.md.
- Vendor READMEs: added "Reduces friction..." line, added `## License` header, relocated AI-assisted setup section.
- `dockerCp` removed from `dockerUtils.ts`.

### Fixed

- Re-attach path defaulted to root for install/start when `remoteUser` was set in `devcontainer.json`.
- Extensions installed via `docker cp` were root-owned; now written as `remoteUser`.
- Recent folders never populated (dead `globalState` store); replaced with `FolderHistoryManager`.
- Stale upgrade notes removed from README and vendor templates.

## 0.6.2

- Patch transitive deps (brace-expansion, fast-uri)
- Ignore `plans/` in eslint

## 0.6.1

### Fixed

- Podman compatibility: the sidebar container list crashed on podman's docker-compat output (`Names` as an array, `Id` vs `ID`). Verified against podman 5.4.2.
- Added podman-specific unit tests covering the compat output to prevent future regression.
- Extension install failures now log the underlying error per extension instead of just the count.

## [0.6.0]

### Added

- On-disk REH download cache (cacache) keyed on the original URL. Cache hits skip the network. 2GB cap with async prune. Synced from zygos.
- Container config change detection. Containers now record a hash of devcontainer.json, Dockerfile, and compose files at build time. On reopen or reconnect, if the config changed, you're prompted to rebuild or continue anyway.
- Server reuse on reconnect. A healthy running server is reused instead of killed and restarted, cutting reconnect time. Dead or unresponsive servers are cleaned up and restarted.

### Changed

- Reopen in Container now reuses an existing container (running or stopped) instead of rebuilding it, matching the official extension. Only explicit Rebuild recreates the container.

- `tsconfig.json` adds `"types": ["node"]` for cacache type resolution.

## [0.5.0]

### Added

- REH server download URL templating, checksum verification, and per-fork config from zygos. Shared files synced via `make sync-shared`; drift checked in `make build` / `make check`.
- `artizo.configureServerDownload` command and `artizo.serverDownload` settings.
- Server-download config webview.
- Better `code-oss` support via bundled vscodium version feed. `make vscodium-versions` refreshes it.
- IPv6 listener detection in `portDetector`.

### Changed

- Server install dir now uses the IDE commit id (`bin/<ide-commit>/`) instead of the REH commit, matching zygos. Existing installs need a one-time rebuild.
- Askpass env vars renamed to `AERGIC_SSH_ASKPASS_*`, shared with zygos.
- Server install log messages distinguish reuse vs. fresh install.
- ESLint upgraded to 10.8.0.

### Removed

- `scripts/guard-bundle.mjs` brand guard.
- Dead "Rebuild on config change" prompt in `configWatcher`.

### Fixed

- Throw inside a stream `'error'` listener could crash the extension host.
- Repos without a devcontainer config could never be cloned in a volume, and leaked the volume.
- Default `~/dotfiles` target never worked.
- Respawned ssh tunnel orphaned when `stop()` raced the respawn.
- Path traversal via VSIX filename.
- `parseContainerList` crashed on non-JSON stdout.
- `parseLabelString` corrupted label values with commas.
- `Host.exec` silently ignored `cwd`.
- Sidebar listeners leaked per webview resolution.
- Half-activated state when activation bailed mid-way.
- Dead "Retry" button in failure toasts.
- Override-config temp files accumulated forever.
- ExecServer `run()` timeout killed but never rejected.
- Tunnel respawn retried forever.
- Orphaned relay daemon when `waitForPortFile` timed out.
- `forwardContainerPort` children leaked on dispose.
- Vendor CLI require failure poisoned the lazy-load cache.
- Spawn-level docker failures collapsed to useless errors.
- Attach-by-ID persisted configs under the wrong key.
- Existing-container lookup orphans containers when the config file moves.
- Kiro adapter fallback URL pointed at Microsoft's CDN.
- Image-prune count off by one.
- `sleepDetector.stop()` cleared the listener set.
- Download stream error leaked handle and partial VSIX.
- Malformed dependency entries became `"undefined.undefined"`.
- Host-side ssh-agent socket never closed in dispose.
- `getConfigPath` swallowed all `stat` errors.
- SSH port from `ssh-remote+user@host:port` authorities was dropped; sideload, tunnel, and relay now pass `-p <port>`.
- Webview command execution allowlist added.

## 0.4.3

- Fix `updateUID.Dockerfile` missing from VSIX causing container
 provisioning to fail when `updateRemoteUserUID` runs; restructure
 bundle to `dist/extension/extension.js` so the vendored CLI's
 `path.join(__dirname, '..', '..')` resolves to the extension root
 and finds `scripts/updateUID.Dockerfile`

## 0.4.2

- Fix `updateRemoteUserUID` being ignored in devcontainer.json by
 defaulting `updateRemoteUserUIDDefault` to `on` instead of `never`
- Minor doc/build fixes (Makefile wording, VSIX ignores)

## 0.4.1

- Install REH server to `bin/<reh-commit>/` using the tarball's
 product.json commit, not the IDE's
- Drop `--extensions-dir`; the server discovers user extensions via
 `--server-data-dir`
- Reword extension install bullet in READMEs
- Separate build terminal creation from logger init
- Skip README.md at VSIX copy stage to avoid case-collision

## 0.4.0

- ExecServer bridge replaces ssh -L tunnel when zygos is the
 resolver, eliminating the second SSH auth and password prompt
- Lazy-load sidebar data on visibility instead of eager fetch
- Lazy-create build terminal on first show() with header to fix
 empty terminal on first build
- Sidebar "Show Log" now opens diagnostics output, not build terminal
- Exclude aergic.zygos-* from extension list in devcontainer.json
 editor
- Downgrade getServerInstallRoot log to debug
- Fix socket resume race in bridge

## 0.3.0

- SSH remote support: open folders on a remote SSH host and run
devcontainers from there. Artizo installs itself onto the remote
on first connect.
- Mirror locally-installed extensions onto the SSH remote during setup
- "Open Folder in Container (New Window)" command
- Reopen/Rebuild/Open Folder reuse the current window
- "Close Remote Connection" and "Reopen in Host" return to the
originating folder for both local and SSH origins
- "Attach to Running Container" no longer fails with "workflow already
in progress"
- Expanding Containers/Volumes accordion refreshes the list from Docker
- Logging moved to an Output channel with log-level picker
- Internal: removed CommunicationBridge singleton, split sidebar
provider into focused pieces, dead code cleanup

## 0.2.0

- Add support for VSCodium
- AI detection probes Cline, Roo Code, and Zoo Code at runtime
- Mismatch sidebar when wrong Artizo plugin installed
- Webview AI tabs gated on aiAvailable; simple labels when no AI

## 0.1.0

- AI-assisted config creation, update, and syntax repair on all platforms
- Tabbed wizard UI for config create/update flows
- Sidebar rewritten with event delegation and dispatch table
- JSONC repair pipeline with bracket balancing and bare-value fixing
- Log terminal survives user-close: "Show Log" recreates it on demand
- Build failure diagnostics via AI chat where available
- Error banner in sidebar for parse failures with auto-repair and AI fix options
- Per-platform AI chat adapters with build-time tree-shaking

## 0.0.3

- New platform adapter
- Host data folder separated from server data directory

## 0.0.2

- Server version fetched dynamically from CDN
- Dependency upgrades
- Build-time guard against stale merge artifacts in package.json

## 0.0.1

- Initial release
