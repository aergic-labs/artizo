# Artizo Dev Containers

> **0.3.0 upgrade note:** Existing devcontainers must be rebuilt after
> upgrading. The container label scheme changed; old containers will not
> be recognized by Artizo 0.3.0+.

Open any folder inside a Docker container with a full development environment
powered by [devcontainer.json](https://containers.dev).

Reduces friction when developing for linux-centric targets on Windows or macOS.

## Features

- **SSH remotes** - open folders on a remote SSH host and run
devcontainers from there. Artizo installs itself onto the remote
on first connect.
- **Container provisioning** - image, Dockerfile, or Docker Compose
- **AI-assisted setup** - create, update, or repair devcontainer.json
- **JSON repair** - auto-fix syntax errors in broken config files
- **Sidebar panel** - toggle GPU, privileged mode, mounts, ports, extensions
- **Container lifecycle** - start, stop, rebuild, remove
- **Port forwarding** - auto-detect and forward container ports
- **Extension install** - install extensions from devcontainer.json
config into the container
- **Extension mirroring** - copy locally-installed extensions onto SSH
remotes during setup
- **SSH agent forwarding** - use host SSH keys inside the container
- **Git config copy** - mirror host `.gitconfig` into the container
- **Zygos integration** - when [Zygos](https://github.com/aergic-labs/zygos)
  is installed as the remote-ssh plugin, Artizo uses its ExecServer API to
  connect to devcontainers without a second SSH authentication or
  password prompt

## Supported editors

- [Kiro](https://kiro.dev)
- [Trae](https://trae.ai)
- [Devin](https://devin.ai)

## Why

Microsoft's Dev Containers extension is terrific, but closed-source and locked to
the official VS Code IDE.

Artizo Dev Containers provides the same functionality for Kiro, Trae, and Devin
by leveraging the open-source `@devcontainers/cli` and reimplementing the IDE
integration layer from scratch.

## Requirements

- A supported editor (see above)
- Docker CLI client (`docker`)
  - Alternatives like Podman or Rancher work too, provided their
    optional Docker CLI compatibility packages are installed and working.

Everything else is bundled with the extension.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for
the full text.

Commercial licensing: contact@aergic.com

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
