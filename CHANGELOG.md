# Changelog

## 0.11.1

### Fixed

- Add missing `ibm bob` keyword to the vscodium VSIX so it surfaces in IBM Bob marketplace searches.

## 0.11.0

### Added

- IBM Bob IDE support: `bob` in `FORK_TEMPLATES`, `applicationName` detection in the unified `VscodiumAdapter` (`.bobide` / `.bobide-server`, `bobide-server`). `BobAiAssist` calls `bob-code.sendMessageWithHiddenPrompt`.
- `getProductInfo` reads `serverDownloadUrlTemplate` from `product.json` (top-level + nested `remote.SSH`) for REH download.
- Download URL type (`custom` / `auto` / `fallback`) logged to the Output channel via shared `downloadUrlLogMessage()`.

### Changed

- Unified `VscodiumAdapter` handles all supported forks (VSCodium, code-oss, VSCode-OSS, Trae, Devin, Antigravity, Qoder, Kiro, Bob); per-fork adapters removed. Trae seccomp, Devin `/tmp` + symlink + `.devin`, Kiro auth sync preserved.
- README refactored into shared sections inherited by `vendor/<target>/README.md` extenders via `<!-- BEGIN/END -->` markers.
- Keywords and fork display names updated for supported IDEs.

### Fixed

- Bumped `follow-redirects`, `minimatch`, and `glob` via npm overrides to clear advisories (GHSA-mrwp-f3q8-3g9p, GHSA-g3hv-75wg-m249, GHSA-3g3m-2fjr-6pw4).

## 0.10.1

### Fixed

- Docker path reads live; toggling `useWslcIfInstalled` or swapping Docker for Podman takes effect without a reload. Runtime kind (docker vs wslc) stays cached and re-probes on config change.
- `PortForwarder` no longer hardcodes `'docker'`; reads live like every other call site.
- `checkDockerAvailable()` no longer takes a captured path arg.
- Bumped `qs` to 6.17.1 to clear a moderate DoS advisory (transitive via `@vscode/vsce`, build-only).

## 0.10.0

### Added

- On Windows, wslc (WSL Containers CLI) runs devcontainers without Docker Desktop. Opt in with `artizo.useWslcIfInstalled`; `artizo.wslcPath` overrides the executable. Skips the vendored CLI's `buildx version` probe when active.

### Removed

- Trae and Devin standalone VSIX build paths (`make package-trae`/`package-devin`, `vendor/trae`/`vendor/devin`).
- Deprecation toast and sidebar banner for the trae/devin VSIXes

### Fixed

- Reopen/attach/clone-in-volume pass the resolved Docker path to inspect/volume-rm, so wslc-managed containers/volumes are visible.
- Volume create/clone-in-volume pass the resolved Docker path through, so wslc volumes land in wslc, not Docker Desktop.
- Volume create logs the volume name (`Created volume: <name>`).
- All Docker call sites route through `getDockerPath()`; no `dockerPath` arg can silently hit Docker Desktop when wslc is active.
- wslc mount parsing: vendored `convertMountToVolume`/`parseMount` now split on `,` and `;`, so `;`-separated mounts and multi-mount dedup work.
- Command-abort UX: canceling a prompt (clone-in-volume, create-volume, clean-up-containers) logs `Cancelled.` instead of `Done.`

## 0.9.0

### Added

- Moved trae and devin support into the vscodium build and deprecated the standalone VSIXes. Installed copies show a toast and unremovable banner pointing to the supported build for their IDE (Kiro -> aergic.artizo-kiro; else -> aergic.artizo-vscodium).
- Bundled VSCodium version fallback (`getNewestBundledVersion`) moved from the shared `src/remote/vscodiumFeed.ts` to an artizo-local `src/platform/vscodiumBundledVersion.ts`.

### Changed

- Removed `*` from `activationEvents`.
- Bumped `@azure/msal-node` to `^7.1.0` (override) and refreshed transitive deps in `package-lock.json` to clear npm audit vulnerabilities.
- Default test timeout raised to 15s. Windows Docker Desktop adds ~10s to stop/inspect calls; the 5s vitest default timed out the integration lifecycle tests.

### Fixed

- Relay heal recovers after relay death (idle timeout, sleep, host reboot) instead of timing out. Re-spawns the daemon with the original node binary, and assembles the heal script with newlines instead of `; ` so `sh -c` parses it.
- Removed the stale-relay sweep that raced a concurrent window's relay-heal and could kill a daemon another window had just started. Recovery now relies on relay-heal.
- `scripts/download-busybox.mjs` retries `writeFile` on Windows AV (Defender) transient locks (`UNKNOWN`/`EBUSY`/`EPERM`/`EACCES`) with backoff. A scan on a freshly-written busybox binary used to fail the package build.
- Sidebar webview no longer flashes empty/unstyled on open. A `Loading…` placeholder covers the CSS-load and empty-state flashes; `app.js` swaps it for `#root` on first state message.

## 0.8.10

### Fixed

- `config_hash` label is now stable, so rebuild finds the old container instead of creating a duplicate (#17).
- Drift dialogs now reopen the window after rebuild instead of stranding it (#17).
- Recents lookup sees stopped containers (`docker ps -a`), so reopening a stopped devcontainer no longer reports it missing (#17).
- `buildAuthorityAndOpen` now logs when `openWindow` returns; a silent abandon shows as a returned open with no matching `resolve()` (#17).
- Server fast-path re-bootstraps `/tmp/.artizo/bin` when nohup is gone, so a persistent install root on an ephemeral `/tmp` no longer strands the start (#17).
- Server install adoption now gates on the IDE commit: a stale install from a previous IDE version is never adopted (#17).
- Server start prunes superseded `bin/<old-commit>/` dirs (24h age gate) after confirming the new server is up, so a persistent install root doesn't bloat across IDE upgrades without risking a concurrent window's fresh install (#17).

## 0.8.9

### Fixed

- Reconnecting to a devcontainer over SSH now recovers if the relay on the remote host has died (laptop slept, host rebooted, crash) instead of timing out with `Connection refused`. If the container is gone, the error says so plainly instead of showing an opaque id.
- Preserve exec bits on bundled VSIX binaries (#16).
- Bump vite, follow-redirects, vitest, @vitest/mocker for dev-dep advisories.

## 0.8.8

### Changed

- Platform and AI adapter selection now reads `product.json` at runtime instead of compile-time flags, so any VSIX works in any IDE. `validatePlatformRuntime` removed.

### Fixed

- Dev-dep advisories (6 high): `@vscode/vsce` bumped to 4.0.0 with `overrides` forcing ovsx's nested vsce to 4.0.0, pruning the secretlint/braces chain.

## 0.8.7

### Fixed

- `~` is now expanded in `artizo.sshPath` (e.g. `~/bin/ssh`).

## 0.8.6

### Fixed

- Extensions from `customizations.vscode.extensions` now install as application-scoped so they appear in every profile, not just the Default (#13).

## 0.8.5

### Added

- `userEnvProbe` (default `loginInteractiveShell`): probe the remote user's login-shell env on cold start and inject it into the server so integrated terminals, tasks, and debug adapters inherit the full env instead of the bare image env. Shell comes from the existing getent call and PATH from probeContainer, so no new round-trips.

### Fixed

- `${localEnv:...}` and friends now resolved across the whole config - `remoteEnv`, `workspaceFolder`, etc. - before reaching the server. Previously only `workspaceFolder` was substituted (#12).

## 0.8.4

### Fixed

- Probe output (container probe, ssh home probe) now anchors on a per-invocation nonce marker, so shell-init output can't corrupt the parsed fields.

## 0.8.3

### Fixed

- Save/restore busybox PATH so it does not leak busybox coreutils into the vscodium server. (Parallel of zygos #5)
- Dev-dep advisories: `vitest`/`@vitest/mocker` (GHSA-82fw-gwwq-j7x9) and `js-yaml` (GHSA-2883-xcg3-v3hh) via vitest 4→5 bump and transitive update.
- Fixes for various lint warnings from the dep updates.

## 0.8.2

### Fixed

- Extensions from `customizations.vscode.extensions` never installed (#11): missing destination mkdir before tar extraction, Windows-apex tar modes producing non-traversable dirs, and PATH-probed tar instead of the bootstrapped busybox.
- "Workspace does not exist" on reopen (#12): devcontainer variables in `workspaceFolder` are now resolved before building the remote window URI.

## 0.8.1

### Fixed

- Kiro AI assist updated to match changes in Kiro's agent API.

## 0.8.0

### Added

- Dotfiles support: `artizo.dotfiles.*` settings (repo, target, install command) wired into `withDefaults` via `dotfilesFromConfig()`. Clones and installs on container create/reopen/rebuild/clone-in-volume.
- `artizo.createVolume` command and sidebar button - creates an empty managed volume with name prompt.

### Changed

- Sidebar icons switched from emoji/unicode to codicons throughout (container/volume/command rows, chevrons, tab icons, refresh buttons). Codicon CSS+TTF are static files in `resources/sidebar/`.
- Sidebar accordion open/close now animated via `grid-template-rows` transition (0.15s ease). Containers, volumes, config, and command groups use a unified `.accordion-group` wrapper.
- `renderCommands` accordions default to open.
- "Open Different Folder in Container" → "Open a Folder in Container" (and New Window variant).
- Removed `artizo.explorer.cloneInVolume` command (duplicate of `artizo.cloneInVolume`).
- AI assist prompt (`generate.md`) gives generic host-OS-aware guidance for display forwarding (Linux native, WSL/WSLg, XQuartz) and detects GUI toolkits (Qt, GTK, wxWidgets, Tkinter, PyQt, Electron) and GPU/CUDA, instead of emitting specific mount syntax.

### Removed

- X11 and Wayland display socket toggles. They only worked in narrow host-OS cases; the AI assist prompt now guides users generically.

### Fixed

- Sidebar horizontal jitter when the scrollbar appears/disappears. `.panel` now uses `flex: 1; min-height: 0`.

## 0.7.1

### Fixed

- Auth token forwarding now includes the `<clientIdHash>.json` registration sibling so the remote can refresh its own tokens. Previously only `kiro-auth-token.json` was forwarded; the remote would sign out ~1 hour into every session.
- `tools/setup.sh`: auth file writes are atomic (temp + mv) and non-fatal on read-only bind-mounts. HOME detection moved before auth writes.
- Reconnect now runs `postStartCommand` and `postAttachCommand` via the CLI's `launchProvision({expectExistingContainer: true})` instead of a bare `docker start`. Previously lifecycle hooks were silently skipped on reconnect (X11 display failures, etc.).
- `resolveContainerById` path also runs lifecycle hooks (best-effort, non-blocking) before server install.

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
