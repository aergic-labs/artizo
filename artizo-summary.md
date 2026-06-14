# Artizo — Project Summary

Artizo brings VS Code-style dev containers to third-party IDEs (Kiro, Trae,
Devin). Users define their environment in `devcontainer.json` and the
extension provisions Docker containers, installs the IDE server inside, and
bridges the connection.

## Scale

| Metric | Value |
|--------|-------|
| Source (TypeScript) | ~11,200 lines |
| Tests (TypeScript) | ~15,100 lines |
| Test count | 829 tests in 58 files |
| Test-to-code ratio | 1.35:1 |
| Coverage | 71% lines, 60% branches, 74% functions |
| Runtime deps | 3 (`ajv`, `jsonc-parser`, `vscode-uri`) |
| Dev deps | 10 |
| Platform adapters | 4 |
| Build output | 4 VSIX files, ~2.6 MB each |

## Architecture

**Platform adapter pattern** — one adapter per IDE (~30 lines each): server
download URL, binary name, data folder conventions. esbuild tree-shakes to a
single adapter per VSIX. Adding a new IDE is ~4 files.

**No forked CLI** — ships the open-source `@devcontainers/cli` (bundled,
compiled from vendored source) rather than reimplementing container
provisioning.

**Credential forwarding** — SSH agent and Git config pass-through to the
container.

**Property-based testing** (`fast-check`) for core invariants: URI round-trips,
config preservation, bug condition reproduction.

**TypeScript strict mode** — `noUnusedLocals`, `noUnusedParameters`, zero
implicit any.

## Quality

- All 829 tests pass, 0 TypeScript errors, 0 audit vulnerabilities
- Integration tests exist but require Docker (gated behind `test:integration`)
- Build pipeline: `lint` → `test` → `test:coverage` → `build` (VSIX per platform)
- Dead-code detection (`knip`) in lint
- Lint guard for stale build-merge artifacts in `package.json` and `package-lock.json`

## Build

Single `make build` produces four VSIX files with platform-specific manifests.
`make publish` pushes all four to Open VSX.

## File structure

```
.
├── .editorconfig
├── .gitignore
├── .gitmodules
├── .knip.json
├── .vscodeignore
├── AGENTS.md
├── CHANGELOG.md
├── LICENSE
├── Makefile
├── NOTICE
├── README.md
├── esbuild.config.mjs
├── package.json
├── resources/
│   ├── icon.png
│   └── icon.svg
├── screenshot.png
├── scripts/
│   ├── build-vsix.mjs
│   ├── download-busybox.mjs
│   ├── guard-pkg.mjs
│   └── parse-coverage.mjs
├── tsconfig.json
│
├── src/
│   ├── extension.ts
│   ├── config/
│   │   ├── configManager.ts
│   │   ├── configWatcher.ts
│   │   └── schemaValidator.ts
│   ├── credentials/
│   │   ├── credentialForwarder.ts
│   │   ├── gitConfigCopier.ts
│   │   └── sshAgentForwarder.ts
│   ├── devcontainer/
│   │   ├── api.ts
│   │   └── templates.ts
│   ├── docker/
│   │   ├── compose.ts
│   │   └── execPolicy.ts
│   ├── dotfiles/
│   │   └── dotfilesManager.ts
│   ├── extensions/
│   │   ├── extensionClassifier.ts
│   │   ├── extensionInstaller.ts
│   │   └── marketplaceClient.ts
│   ├── host/
│   │   ├── adapters.ts
│   │   ├── commandRunner.ts
│   │   ├── commands.ts
│   │   ├── guards.ts
│   │   └── services.ts
│   ├── lifecycle/
│   │   └── containerLifecycle.ts
│   ├── platform/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── kiro.ts
│   │   ├── trae.ts
│   │   └── devin.ts
│   ├── ports/
│   │   ├── portDetector.ts
│   │   ├── portForwarder.ts
│   │   └── portView.ts
│   ├── remote/
│   │   ├── authorityResolver.ts
│   │   ├── bootstrap.ts
│   │   ├── communicationBridge.ts
│   │   ├── productInfo.ts
│   │   ├── relay.js
│   │   └── serverManager.ts
│   ├── sidebar/
│   │   ├── commandRegistry.ts
│   │   ├── configToggles.ts
│   │   ├── containerService.ts
│   │   ├── messages.ts
│   │   ├── provider.ts
│   │   └── volumeService.ts
│   ├── terminal/
│   │   └── outputParser.ts
│   ├── utils/
│   │   ├── constants.ts
│   │   ├── dockerUtils.ts
│   │   ├── logger.ts
│   │   ├── shellUtils.ts
│   │   └── uriUtils.ts
│   ├── views/
│   │   ├── containerExplorer.ts
│   │   ├── detailsView.ts
│   │   ├── treeItems.ts
│   │   └── volumesView.ts
│   ├── webview/
│   │   ├── app.js
│   │   └── styles.css
│   └── workflows/
│       ├── orchestrator.ts
│       ├── orchestrator-config.json
│       ├── types.ts
│       ├── attachToContainer.ts
│       ├── cloneInVolume.ts
│       ├── configWizard.ts
│       ├── devcontainerDetector.ts
│       ├── logOutputTerminal.ts
│       ├── openFolder.ts
│       ├── postLaunch.ts
│       ├── rebuildContainer.ts
│       ├── reopenInContainer.ts
│       └── vscodeUI.ts
│
├── stubs/
│   └── node-pty.js
│
├── test/
│   ├── setup.ts
│   ├── __mocks__/
│   │   └── vscode.ts
│   ├── integration/
│   │   ├── docker.integration.test.ts
│   │   └── fixtures/
│   │       └── minimal-image/.devcontainer/devcontainer.json
│   ├── property/
│   │   ├── bugCondition.property.test.ts
│   │   ├── preservation.property.test.ts
│   │   └── uriRoundTrip.property.test.ts
│   └── unit/
│       ├── adapters.test.ts
│       ├── attachToContainer.test.ts
│       ├── authorityResolver.test.ts
│       ├── bootstrap.test.ts
│       ├── cloneInVolume.test.ts
│       ├── commandRegistry.test.ts
│       ├── commandRunner.test.ts
│       ├── commands.test.ts
│       ├── communicationBridge.test.ts
│       ├── configManager.test.ts
│       ├── configWatcher.test.ts
│       ├── configWizard.test.ts
│       ├── containerExplorer.test.ts
│       ├── containerLifecycle.test.ts
│       ├── containerVolumeService.test.ts
│       ├── credentialForwarder.test.ts
│       ├── detailsView.test.ts
│       ├── devcontainerApi.test.ts
│       ├── devcontainerDetector.test.ts
│       ├── devin.test.ts
│       ├── dockerCompose.test.ts
│       ├── dockerUtils.test.ts
│       ├── dotfilesManager.test.ts
│       ├── execPolicy.test.ts
│       ├── extension.test.ts
│       ├── extensionClassifier.test.ts
│       ├── extensionInstaller.test.ts
│       ├── gitConfigCopier.test.ts
│       ├── guards.test.ts
│       ├── kiro.test.ts
│       ├── logger.test.ts
│       ├── logOutputTerminal.test.ts
│       ├── marketplaceClient.test.ts
│       ├── openFolder.test.ts
│       ├── orchestrator.flow.test.ts
│       ├── outputParser.test.ts
│       ├── platformIndex.test.ts
│       ├── portDetector.test.ts
│       ├── portForwarder.test.ts
│       ├── portView.test.ts
│       ├── productInfo.test.ts
│       ├── rebuildContainer.test.ts
│       ├── reopenInContainer.test.ts
│       ├── schemaValidator.test.ts
│       ├── serverManager.test.ts
│       ├── services.test.ts
│       ├── showBuildLog.test.ts
│       ├── sidebarProvider.test.ts
│       ├── sshAgentForwarder.test.ts
│       ├── templates.test.ts
│       ├── trae.test.ts
│       ├── uriUtils.test.ts
│       ├── volumesView.test.ts
│       └── vscodeUI.test.ts
│
├── tools/
│   ├── relay.js
│   ├── setup.sh
│   └── busybox/
│       ├── bb-x64
│       └── bb-arm64
│
├── vendor/
│   ├── devcontainers-cli/          (vendored @devcontainers/cli ~300 files)
│   ├── kiro/package.json, README.md
│   ├── trae/package.json, README.md
│   └── devin/package.json, README.md
│
└── test-project/
    ├── .devcontainer/devcontainer.json
    ├── .devcontainer/devcontainer-lock.json
    ├── index.js
    └── README.md
```
