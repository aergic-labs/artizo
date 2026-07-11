# Artizo Dev Containers for VSCodium

> **0.3.0 upgrade note:** Existing devcontainers must be rebuilt after
> upgrading. The container label scheme changed; old containers will not
> be recognized by Artizo 0.3.0+.

Open any folder inside a Docker container with a full development environment
powered by [devcontainer.json](https://containers.dev).

## Features

- **SSH remotes** - open folders on a remote SSH host and run
devcontainers from there. Artizo installs itself onto the remote
on first connect.
- **Container provisioning** - image, Dockerfile, or Docker Compose
- **JSON repair** - auto-fix syntax errors in broken config files
- **Sidebar panel** - toggle GPU, privileged mode, mounts, ports, extensions
- **Container lifecycle** - start, stop, rebuild, remove
- **Port forwarding** - auto-detect and forward container ports
- **Extension install** - sync local extensions into the container
- **Extension mirroring** - copy locally-installed extensions onto SSH
remotes during setup
- **SSH agent forwarding** - use host SSH keys inside the container
- **Git config copy** - mirror host `.gitconfig` into the container
- **Zygos integration** - when [Zygos](https://github.com/aergic-labs/zygos)
  is installed as the remote-ssh plugin, Artizo uses its ExecServer API
  to connect to devcontainers without a second SSH authentication or
  password prompt

### AI-assisted setup (optional)

Install an AI coding extension to enable AI-powered config creation and repair:

- [Cline](https://github.com/cline/cline) - install via Open VSX
- [Roo Code](https://github.com/RooVeterinaryInc/Roo-Code) - install via Open VSX
- [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code) - install via Open VSX

Once installed, the Artizo sidebar will offer AI-generated devcontainer.json setup
and automated build-failure diagnosis.

## Requirements

- [VSCodium](https://vscodium.com) - including code-oss and other VS Code OSS builds
- Docker CLI client (`docker`)
  - Alternatives like Podman or Rancher work too, provided their
    optional Docker CLI compatibility packages are installed and working.

Everything else is bundled with the extension.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for the full text.

Commercial licensing: contact@aergic.com

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
