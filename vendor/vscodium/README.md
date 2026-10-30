# Artizo Dev Containers for VSCodium

Open any folder inside a Docker container with a full development environment
powered by [devcontainer.json](https://containers.dev). Supports VSCodium,
VSCode-OSS, Trae, Devin, Antigravity, Qoder, Windsurf, and
other VS Code forks.

Reduces friction when developing for linux-centric targets on Windows or macOS.

Sister project to [Zygos](https://github.com/aergic-labs/zygos), our
remote-ssh extension. Together they give VSCodium a complete remote
development stack: SSH host + devcontainer chaining via
`resolveExecServer`.

## Features

{{section:features-head}}
- **AI-assisted setup** - create, update, or repair devcontainer.json with integrated AI assist
{{section:features-tail}}

## Requirements

- A supported VS Code fork: VSCodium, VSCode-OSS, Trae,
  Devin, Antigravity, Qoder, Windsurf, or other VS Code fork.
{{section:requirements-tail}}

## Disabling other Dev Containers extensions

Some VS Code forks (e.g. Antigravity, Qoder) ship with their own Dev
Containers extension. Artizo registers VS Code authority resolvers for
`artizo-container` (its own scheme, no conflict) and `attached-container`
(the shared scheme used by **Attach to Running Container**). If the
fork's built-in Dev Containers extension is also active, both register
a resolver for `attached-container`, and VS Code may route attach
requests through the wrong one (failing to connect, or launching the
wrong server binary). The two extensions also contribute duplicate
status-bar entries and sidebar views.

(Microsoft's `ms-vscode-remote.remote-containers` is not a concern
here - it's blocked from running on non-VS Code products, which is why
Artizo exists.)

If your IDE shipped with another Dev Containers extension, disable it
before using Artizo:

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for the other Dev Containers extension.
3. Click **Disable** (or **Uninstall**).
4. Reload the window.

## Getting started

1. Install this extension in VSCodium.
2. Open a folder containing (or about to contain) a
   `.devcontainer/devcontainer.json`.
3. Run **Artizo: Reopen in Container**.
4. The first build downloads the REH server and provisions the
   container; subsequent reconnects are fast.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `artizo.dockerPath` | `docker` | Path to the Docker executable. |
| `artizo.wslcPath` | `wslc` | Path to the wslc (WSL Containers CLI) executable. Probed on Windows when **Use Wslc If Installed** is on. |
| `artizo.useWslcIfInstalled` | `false` | On Windows, prefer wslc over Docker for devcontainer provisioning. wslc has no Compose runtime and cannot bind-mount WSL host paths; uncheck for those projects. |
| `artizo.sshPath` | `""` | Path to the ssh executable used for remote SSH tunnels and side-load. When empty, Artizo uses the Windows OpenSSH client if present, otherwise ssh from PATH. |
| `artizo.copyGitConfig` | `true` | Copy host `.gitconfig` into dev containers. |
| `artizo.askpass` | `true` | Surface SSH password/passphrase prompts as VS Code input boxes. |
| `artizo.askpassCacheTtl` | `8` | Hours that cached SSH passphrases survive. 0 = never expire. |
| `artizo.askpassKeyRotationDays` | `7` | Days before the askpass cache master key rotates. 0 = never. |
| `artizo.logLevel` | `info` | Output channel log level: `info`, `debug`, `trace`. |
| `artizo.remote.ssh.mirrorExtensions` | `false` | Copy locally-installed extensions to the SSH remote host during setup. |
| `artizo.dotfiles.repository` | `""` | Dotfiles repository URL to clone into containers. |
| `artizo.dotfiles.installCommand` | `""` | Command to run after cloning dotfiles. |
| `artizo.dotfiles.targetPath` | `~/dotfiles` | Target path for dotfiles inside the container. |
| `artizo.serverDownload` | `{}` | Server download config. Use the wizard (**Artizo: Configure Server Download**) instead of editing directly. |

## Custom download URL

Out of the box, Artizo reads `product.json` to build the correct REH server
tarball URL for the detected fork. For VSCodium that is:

```
https://github.com/VSCodium/vscodium/releases/download/<version>/vscodium-reh-linux-<arch>-<version>.tar.gz
```

For custom forks, VSCode-OSS built from source, or mirrors, use the
**Artizo: Configure Server Download** command to switch to custom mode and
set a template. Variables are substituted from `product.json`:

| Variable | Meaning |
|----------|---------|
| `${version}` | `product.json` version string |
| `${commit}` | `product.json` commit |
| `${release}` | Alias for `${version}` (or `${commit}` if version is empty) |
| `${os}` | `linux` (macOS reserved) |
| `${arch}` | `x64`, `arm64`, `armhf` |
| `${quality}` | `product.json` quality (`stable` by default) |
| `${platform}` | Alias for `${arch}` |

Example for a custom fork (set via the configuration wizard):

```
https://cdn.example.com/reh/${version}/myfork-reh-${os}-${arch}.tar.gz
```

The wizard's **Test** button verifies a custom template resolves to a
reachable URL before applying.

### AI-assisted setup (optional)

Install an AI coding extension to enable AI-powered config creation and repair:

- [Cline](https://github.com/cline/cline) - install via Open VSX
- [Roo Code](https://github.com/RooVeterinaryInc/Roo-Code) - install via Open VSX
- [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code) - install via Open VSX

Once installed, the Artizo sidebar will offer AI-generated devcontainer.json
setup and automated build-failure diagnosis.

## License

{{section:license}}
