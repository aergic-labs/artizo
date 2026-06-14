# Changelog

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
