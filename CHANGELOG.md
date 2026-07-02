# Changelog

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
