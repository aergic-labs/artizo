# Artizo Dev Containers

A dev containers extension for [Kiro](https://kiro.dev), [Windsurf](https://windsurf.com/), and [Trae](https://trae.ai)

Open any folder or repository inside a Docker container and get a full-featured development environment.

Reduces friction when developing for linux-centric targets on Windows or macOS.

Isolate the AI agent inside the container. It can only easily touch what you mount, nothing else.


## Why

Microsoft's Dev Containers extension is terrifice, but closed-source and locked to the official VS Code IDE. 

Artizo Dev Containers provides the same functionality for Kiro, Windsurf, and Trae by leveraging the open-source `@devcontainers/cli` and reimplementing the IDE integration layer from scratch.

## Requirements

- Kiro, Windsurf, or Trae (any VSCodium-based editor)
- Docker Desktop (or Podman)

That's it. Everything else is bundled with the extension.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for the full text.

Commercial licensing: contact@aergic.com

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
