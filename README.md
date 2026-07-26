# Artizo Dev Containers

<!-- BEGIN:upgrade-notes -->
> **0.3.0 upgrade note:** Existing devcontainers must be rebuilt after
> upgrading. The container label scheme changed; old containers will not
> be recognized by Artizo 0.3.0+.
>
> **Unreleased upgrade note:** The server install path changed from
> `bin/<reh-commit>/` to `bin/<ide-commit>/` to match the official
> devcontainer extension and zygos. Existing containers need a
> one-time rebuild after upgrading so the server re-provisions at the
> new path.
<!-- END:upgrade-notes -->

Open any folder inside a Docker container with a full development environment
powered by [devcontainer.json](https://containers.dev).

Reduces friction when developing for linux-centric targets on Windows or macOS.

## Features

<!-- BEGIN:features-head -->
- **SSH remotes** - open folders on a remote SSH host and run
devcontainers from there. Artizo installs itself onto the remote
on first connect.
- **Container provisioning** - image, Dockerfile, or Docker Compose
- **Server download** - auto-detects the correct REH server tarball
  URL per fork from `product.json`, with checksum verification
  (sidecar or manifest, sha256/md5) before installation. A
  configuration wizard (`Artizo: Configure Server Download`) lets you
  override with a custom template, pick a fork preset, test the URL,
  and configure checksum sources.
<!-- END:features-head -->
- **AI-assisted setup** - create, update, or repair devcontainer.json
<!-- BEGIN:features-tail -->
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
<!-- END:features-tail -->

## Supported editors

- [Kiro](https://kiro.dev)
- [Trae](https://trae.ai)
- [Devin](https://devin.ai)
- [VSCodium](https://vscodium.com) (including code-oss)

## Why

Microsoft's Dev Containers extension is terrific, but closed-source and locked to
the official VS Code IDE.

Artizo Dev Containers does the same for Kiro, Trae, Devin, and
VSCodium, using the open-source `@devcontainers/cli` and
reimplementing the IDE integration layer from scratch.

## Requirements

<!-- BEGIN:requirements-tail -->
- Docker CLI client (`docker`)
  - Alternatives like Podman or Rancher work too, provided their
    optional Docker CLI compatibility packages are installed and working.

Everything else is bundled with the extension.
<!-- END:requirements-tail -->

## License

<!-- BEGIN:license -->
GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for
the full text.

Commercial licensing: contact@aergic.com

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
<!-- END:license -->
