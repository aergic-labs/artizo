# Artizo Dev Containers for Kiro

A dev containers extension for [Kiro](https://kiro.dev).

Open any folder or repository inside a Docker container and get a full-featured development environment.

Reduces friction when developing for linux-centric targets on Windows or macOS.

Isolate the AI agent inside the container. It can only easily touch what you mount, nothing else.

## Why

Microsoft's Dev Containers extension is closed-source and locked to VS Code. 

Artizo Dev Containers provides the same functionality for Kiro by leveraging the open-source `@devcontainers/cli` and reimplementing the IDE integration layer from scratch.

## Requirements

- [Kiro](https://kiro.dev)
- Docker Desktop (or Podman)

That's it. Everything else is bundled with the extension.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for the full text.

Commercial licensing: contact@aergic.com

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
