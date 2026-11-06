/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Resolves dev-container and attached-container authority URIs to container
 * connection info.
 */

import * as vscode from "vscode";
import * as net from "node:net";
import { decodeAuthority } from "../utils/uriUtils";
import {
  dockerInspect,
  type ContainerInfo,
  execFilePromise,
  dockerSpawn,
  tcpRelayScript,
  pipeDockerRelay,
} from "../utils/dockerUtils";
import { getDockerPath } from "../docker/execPolicy.js";
import type { IServerManager } from "./serverManager";
import type { ProxyAuthorityInfo } from "./containerProxy";
import { startManagedSshTunnel, type TunnelController } from "./sshTunnel";
import { startExecServerBridge, type ExecServer as ExecServerLike } from "./execServerBridge";
import { startAskpass } from "../ssh/askpass";
import { checkContainerConfig } from "./configCheck";
import {
  launchProvision,
  withDefaults,
  dotfilesFromConfig,
} from "../devcontainer/api";
import { resolveConfigVars } from "../devcontainer/readResolvedConfig";
import { URI } from "vscode-uri";
import { buildIdentityLabels } from "../workflows/postLaunch";
import { getPlatformAdapter } from "../platform";
import { PortForwarder } from "../ports/portForwarder.js";
import { PortViewProvider } from "../ports/portView.js";
import { getLogger } from "../utils/logger";

const log = getLogger();

/** Connection details for a resolved container authority. */
export interface ResolvedAuthority {
  host: string;
  port: number;
  connectionToken?: string;
}

/** Result of resolving an authority: success or error. */
export type ResolveResult =
  | { type: "success"; authority: ResolvedAuthority }
  | { type: "error"; message: string };

/** The two supported remote authority schemes. */
export const SCHEME_DEV_CONTAINER = "artizo-container";
export const SCHEME_ATTACHED_CONTAINER = "attached-container";

/**
 * Docker labels for associating a dev container with a workspace folder.
 * We set both artizo.* and the generic devcontainer.* label at build time
 * and match either at lookup time.
 */
const LABEL_LOCAL_FOLDER_ARTIZO = "artizo.local_folder";
const LABEL_LOCAL_FOLDER_SPEC = "devcontainer.local_folder";

/**
 * Options for the authority resolver.
 */
export interface AuthorityResolverOptions {
  dockerPath?: string;
  serverManager?: IServerManager;
  /** Extension install path - used to locate the askpass scripts. */
  extensionPath?: string;
  /** Extension context - used to register the Ports view and set the `artizo.connected` context key. */
  context?: vscode.ExtensionContext;
}

/**
 * Remote authority resolver that handles dev-container and attached-container schemes.
 *
 * For dev-container authorities, the hex-encoded portion is a workspace path.
 * The resolver finds the container by matching Docker labels.
 *
 * For attached-container authorities, the hex-encoded portion is a container ID.
 * The resolver looks up the container directly by ID.
 */
export class RemoteAuthorityResolver {
  private readonly dockerPathOverride: string | undefined;
  private serverManager: IServerManager | undefined;
  private forwardServer: net.Server | undefined;
  /** Active sockets + docker exec children from forwardContainerPort. */
  private readonly forwardConnections: Set<{ socket: net.Socket; child: import("node:child_process").ChildProcess }> = new Set();
  /** Extension install path (for locating bundled askpass scripts). */
  private readonly extensionPath: string | undefined;
  /** Extension context (for registering the Ports view + `artizo.connected` context key). */
  private readonly context: vscode.ExtensionContext | undefined;
  /** Port forwarder for user-app ports declared via `forwardPorts` in devcontainer.json. */
  private portForwarder: PortForwarder | undefined;
  /** Ports view provider registered once per extension host. */
  private portViewProvider: PortViewProvider | undefined;
  /**
   * Active SSH tunnels keyed by the local port returned to VS Code. Allows
   * `dispose()` to tear down tunnels (and stop respawn) on extension
   * deactivation.
   */
  private readonly tunnels: Map<number, TunnelController> = new Map();

  constructor(options?: AuthorityResolverOptions) {
    this.dockerPathOverride = options?.dockerPath;
    this.serverManager = options?.serverManager;
    this.extensionPath = options?.extensionPath;
    this.context = options?.context;
  }

  setServerManager(sm: IServerManager): void {
    this.serverManager = sm;
  }

  /**
   * Tear down all SSH tunnels spawned by the proxy path and stop their
   * health sentinels. Call on extension deactivation so we don't leave
   * orphaned `ssh -L` processes or respawn timers.
   */
  dispose(): void {
    for (const tunnel of this.tunnels.values()) {
      tunnel.stop();
    }
    this.tunnels.clear();
    if (this.forwardServer) {
      try {
        this.forwardServer.close();
      } catch {
        /* already closed */
      }
      this.forwardServer = undefined;
    }
    // Destroy active sockets and kill docker exec children so spawned relay
    // processes don't keep running until the container side exits.
    for (const conn of this.forwardConnections) {
      try { conn.child.kill("SIGTERM"); } catch { /* already dead */ }
      try { conn.socket.destroy(); } catch { /* already closed */ }
    }
    this.forwardConnections.clear();
    // Tear down the user-app port forwarder and clear the Ports view context
    // key so the view hides. PortViewProvider is disposed via context.subscriptions.
    void vscode.commands.executeCommand("setContext", "artizo.connected", false);
    if (this.portForwarder) {
      this.portForwarder.dispose();
      this.portForwarder = undefined;
    }
  }

  /**
   * Resolve a remote authority URI to connection info.
   *
   * @param authority - The full authority string (e.g., "artizo-container+7265706f")
   * @returns Resolve result with connection info or error
   */
  async resolve(authority: string): Promise<ResolveResult> {
    let decoded: { scheme: string; id: string };
    try {
      decoded = decodeAuthority(authority);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "error",
        message: `Failed to decode authority: ${message}`,
      };
    }

    const { scheme, id } = decoded;

    // Production State 4: a bare `artizo-container+<hex>` or
    // `attached-container+<hex>` authority whose hex decodes to a JSON payload
    // with `proxy: true`. The workspace-side extension (running on the SSH
    // host after side-load) encodes the SSH endpoint + relay port + container
    // token. The Windows-side resolver opens an `ssh -L` tunnel to the SSH
    // host's relay daemon and returns `127.0.0.1:<local_port>` so VS Code
    // connects through the tunnel. No Docker lookup happens on the apex host.
    const proxy = tryParseProxyPayload(id);
    if (proxy) {
      return this.resolveViaProxy(proxy);
    }

    if (scheme === SCHEME_DEV_CONTAINER) {
      return this.resolveDevContainer(id);
    } else if (scheme === SCHEME_ATTACHED_CONTAINER) {
      return this.resolveAttachedContainer(id);
    }

    return { type: "error", message: `Unknown authority scheme: "${scheme}"` };
  }

  /**
   * Resolve a dev-container authority by workspace path.
   * Finds the container via Docker labels matching the workspace folder.
   */
  private async resolveDevContainer(
    workspacePath: string,
  ): Promise<ResolveResult> {
    const containerId = await this.findContainerByLabel(workspacePath);
    if (!containerId) {
      return {
        type: "error",
        message: `No dev container found for workspace: "${workspacePath}"`,
      };
    }

    return this.resolveContainerById(containerId, { checkConfig: true });
  }

  /**
   * Resolve an attached-container authority by container ID.
   */
  private async resolveAttachedContainer(
    containerId: string,
  ): Promise<ResolveResult> {
    return this.resolveContainerById(containerId);
  }

  /**
   * Try to get an ExecServer from the SSH resolver via the proposed API.
   * Returns undefined if the API is unavailable or the resolver doesn't
   * implement resolveExecServer.
   */
  private async tryGetExecServer(
    sshAuthority: string,
  ): Promise<ExecServerLike | undefined> {
    try {
      const getExecServer = (vscode.workspace as unknown as {
        getRemoteExecServer?: (authority: string) => Promise<ExecServerLike | undefined>;
      }).getRemoteExecServer;
      if (typeof getExecServer !== "function") {
        return undefined;
      }
      const execServer = await getExecServer.call(vscode.workspace, sshAuthority);
      if (execServer) {
        if (typeof execServer.tcpConnect !== "function") {
          return undefined;
        }
        return execServer;
      }
    } catch (err: unknown) {
      log.error(
        `getRemoteExecServer threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return undefined;
  }

  /**
   * Run the config drift check for a container on an SSH host, via the
   * ExecServer. Returns "ok" to proceed or "abort" (user chose Rebuild:
   * the prompt directs them to run Rebuild from the plain-SSH window,
   * since this side cannot drive a rebuild).
   */
  private async checkRemoteConfig(
    execServer: ExecServerLike,
    proxy: ProxyAuthorityInfo,
  ): Promise<"ok" | "abort"> {
    try {
      const { checkContainerConfigRemote } = await import(
        "./configCheckRemote.js"
      );
      // Find the container by the host workspace folder label.
      if (!proxy.hostWorkspacePath) {
        return "ok";
      }
      const { remoteFindContainer } = await import("./configCheckRemote.js");
      const containerId = await remoteFindContainer(
        execServer,
        proxy.hostWorkspacePath,
        (m) => log.debug(m),
      );
      if (!containerId) {
        return "ok";
      }
      const outcome = await checkContainerConfigRemote(
        execServer,
        containerId,
        (m) => log.debug(m),
      );
      if (outcome.kind === "changed") {
        await vscode.window.showWarningMessage(
          `Container config has changed: ${outcome.files.join(", ")}. To rebuild, open the folder on the SSH host and run 'Artizo: Rebuild Container'.`,
          "Continue anyway",
        );
        return "ok";
      }
      if (outcome.kind === "no-label") {
        await vscode.window.showWarningMessage(
          "This container predates config tracking. To enable change detection, rebuild it from the SSH host window.",
          "Continue anyway",
        );
        return "ok";
      }
      if (outcome.kind === "skip") {
        log.info(`Config drift check skipped: ${outcome.reason}`);
      }
      return "ok";
    } catch (err: unknown) {
      log.error(
        `Config drift check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "ok"; // never block resolve on a check failure
    }
  }

  /**
   * State 4 proxy path. The authority was encoded by the workspace-side
   * extension (running on the SSH host) with the relay daemon's listener
   * port, the container's connection token, and the SSH endpoint. The apex
   * host (Windows/macOS) opens an `ssh -L` tunnel from a free local port to
   * the relay on the SSH host, then returns `127.0.0.1:<local_port>` so VS
   * Code connects through the tunnel. No Docker lookup happens here.
   *
   * When the SSH resolver implements resolveExecServer (zygos), an
   * ExecServer bridge is used instead of ssh -L. No ssh process spawned,
   * no askpass, no password prompt.
   *
   * Tunnels and bridges are tracked in `this.tunnels` for cleanup on
   * `dispose()`.
   */
  private async resolveViaProxy(
    proxy: ProxyAuthorityInfo,
  ): Promise<ResolveResult> {
    // Try ExecServer first. When the SSH resolver implements
    // resolveExecServer (zygos does), we get an already-authenticated
    // connection. No ssh -L tunnel, no askpass, no password prompt.
    const execServer = await this.tryGetExecServer(proxy.sshAuthority);
    if (execServer) {
      // Config drift check on the SSH host via the ExecServer. Runs before
      // the bridge is established; a mismatch prompt may abort the resolve.
      const checkOutcome = await this.checkRemoteConfig(execServer, proxy);
      if (checkOutcome === "abort") {
        return {
          type: "error",
          message: "Container configuration changed; rebuild requested.",
        };
      }

      // Self-heal: if the relay daemon on the SSH host died (laptop slept
      // past the 30-min idle timeout, ssh-host reboot, crash), the cached
      // relayPort points at nothing. Probe it; on failure re-spawn the relay
      // through the ExecServer. Only possible when the payload carries the
      // container identity (newer payloads); older payloads skip the heal
      // and fall through to the bridge attempt (today's behavior).
      let relayPort = proxy.relayPort;
      if (proxy.containerId && proxy.containerPort && proxy.installPath) {
        const { probeRelayPort, healRelay } = await import("./relayHeal.js");
        const alive = await probeRelayPort(execServer, relayPort, (m) =>
          log.debug(m),
        );
        if (!alive) {
          const heal = await healRelay(
            execServer,
            {
              containerId: proxy.containerId,
              containerPort: proxy.containerPort,
              installPath: proxy.installPath,
              hostWorkspacePath: proxy.hostWorkspacePath,
            },
            (m) => log.debug(m),
          );
          if (heal.kind === "ok") {
            relayPort = heal.relayPort;
          } else if (heal.kind === "container-missing") {
            return { type: "error", message: heal.message };
          } else if (heal.kind === "error") {
            log.error(`Relay heal failed: ${heal.message}`);
            // Fall through to bridge attempt against the original port;
            // today's behavior is the timeout, no regression.
          }
        }
      }

      try {
        const controller = await startExecServerBridge(
          execServer,
          "127.0.0.1",
          relayPort,
        );
        const localPort = controller.localPort;
        this.tunnels.set(localPort, controller);
        return {
          type: "success",
          authority: {
            host: "127.0.0.1",
            port: localPort,
            connectionToken: proxy.connectionToken,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const action = await vscode.window.showErrorMessage(
          `Artizo remote setup failed: ${message}`,
          "Retry",
        );
        if (action === "Retry") {
          await vscode.commands.executeCommand(
            "workbench.action.reloadWindow",
          );
        }
        return {
          type: "error",
          message: `Artizo execServer bridge failed: ${message}`,
        };
      }
    }

    // Fallback: ssh -L tunnel with askpass.
    let askpassOwned = false;
    let askpass: Awaited<ReturnType<typeof startAskpass>>;
    try {
      askpass = this.extensionPath
        ? await startAskpass(this.extensionPath, {
            title: `Artizo: SSH password for ${proxy.sshHost}`,
            modalPrompt: true,
          })
        : undefined;
      try {
        const controller = await startManagedSshTunnel({
          sshHost: proxy.sshHost,
          sshUser: proxy.sshUser,
          sshPort: proxy.sshPort,
          remotePort: proxy.relayPort,
          askpass,
        });
        const localPort = controller.localPort;
        // Tear down the askpass server alongside the tunnel so we don't
        // leave a listening socket/pipe orphaned on extension deactivation.
        if (askpass) {
          askpassOwned = true;
          const askpassServer = askpass.server;
          const originalStop = controller.stop.bind(controller);
          controller.stop = () => {
            originalStop();
            void askpassServer.stop().catch(() => {
              /* best effort */
            });
          };
        }
        this.tunnels.set(localPort, controller);
        return {
          type: "success",
          authority: {
            host: "127.0.0.1",
            port: localPort,
            connectionToken: proxy.connectionToken,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Evict host passwords so a retry re-prompts instead of reusing
        // a bad password.
        if (askpass?.server.usedHostPassword) {
          await askpass.server.evictHostPasswords();
        }
        const action = await vscode.window.showErrorMessage(
          `Artizo SSH tunnel failed: ${message}`,
          "Retry",
        );
        if (action === "Retry") {
          await vscode.commands.executeCommand(
            "workbench.action.reloadWindow",
          );
        }
        return {
          type: "error",
          message: `Artizo SSH tunnel failed: ${message}`,
        };
      }
    } finally {
      // Stop the askpass server only if the controller didn't take
      // ownership of its lifecycle (i.e. the tunnel failed).
      if (askpass && !askpassOwned) {
        await askpass.server.stop().catch(() => {
          /* best effort */
        });
      }
    }
  }

  /**
   * Run devcontainer lifecycle hooks (postStartCommand, postAttachCommand)
   * on an existing container via the CLI. One-time hooks are skipped by
   * the CLI's marker logic. Best-effort: failures are logged but don't
   * block the resolve (the server can still start without hooks).
   */
  private async runLifecycleHooks(
    containerInfo: ContainerInfo,
  ): Promise<void> {
    const workspaceFolder =
      containerInfo.config.labels["artizo.local_folder"] ||
      containerInfo.config.labels["devcontainer.local_folder"];
    const configPath =
      containerInfo.config.labels["artizo.config_file"] ||
      containerInfo.config.labels["devcontainer.config_file"];

    if (!workspaceFolder) {
      return;
    }

    try {
      const adapter = await getPlatformAdapter();
      const platformTarget = adapter.name.toLowerCase();
      const idLabels = await buildIdentityLabels({
        platformTarget,
        workspaceFolder,
        configPath,
        config: undefined,
      });

      const options = withDefaults({
        ...dotfilesFromConfig(vscode.workspace.getConfiguration()),
        workspaceFolder,
        additionalLabels: idLabels,
        configFile: configPath ? URI.file(configPath) : undefined,
        expectExistingContainer: true,
        removeExistingContainer: false,
        log: (text: string) => log.info(text),
      });

      const result = await launchProvision(
        options,
        configPath,
        undefined,
        idLabels,
      );
      // Finish any background tasks the CLI started (e.g. non-blocking hooks).
      if (result?.finishBackgroundTasks) {
        await result.finishBackgroundTasks();
      }
    } catch (err: unknown) {
      // Best-effort: don't block the resolve if hooks fail. The server
      // can still start without them - but the user must know their
      // postStart/postAttach hooks did not run.
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Lifecycle hooks failed: ${message}`);
      void vscode.window
        .showWarningMessage(
          `Artizo: devcontainer lifecycle hooks failed and were skipped: ${message}`,
          "Open Output",
        )
        .then((action) => {
          if (action === "Open Output") {
            log.show();
          }
        });
    }
  }

  /**
   * Resolve a container by its ID, verify it's running, and return connection info.
   */
  private async resolveContainerById(
    containerId: string,
    options?: { checkConfig?: boolean },
  ): Promise<ResolveResult> {
    let containerInfo: ContainerInfo;
    try {
      containerInfo = await dockerInspect(containerId, {
        dockerPath: this.dockerPathOverride ?? getDockerPath(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "error",
        message: `Failed to inspect container "${containerId}": ${message}`,
      };
    }

    if (!containerInfo.state.running) {
      return {
        type: "error",
        message: `Container "${containerId}" is not running (status: ${containerInfo.state.status})`,
      };
    }

    if (options?.checkConfig) {
      const hashCheck = await checkContainerConfig(containerInfo);
      if (hashCheck === "rebuild") {
        return {
          type: "error",
          message: "Container configuration changed; rebuild requested.",
        };
      }
    }

    if (this.serverManager) {
      try {
        // Recover remoteUser (from our label) and containerUser (from
        // Config.User) so re-attach runs install/start as the right user
        // instead of defaulting to root. Both come from the existing
        // dockerInspect call above - no new docker calls.
        const remoteUser =
          containerInfo.config.labels["artizo.remote_user"];
        const containerUser =
          containerInfo.config.user &&
          containerInfo.config.user !== "root"
            ? containerInfo.config.user
            : undefined;
        const user = remoteUser || containerUser;

        // Read the devcontainer.json from the config-file label so the
        // env probe gets `userEnvProbe` and `remoteEnv`. If the file is
        // gone or unreadable (e.g. cloned into a volume and since
        // deleted), pass undefined - the probe uses the default
        // loginInteractiveShell and remoteEnv is skipped.
        const configFilePath =
          containerInfo.config.labels["artizo.config_file"] ||
          containerInfo.config.labels["devcontainer.config_file"];
        const workspaceFolderLabel =
          containerInfo.config.labels["artizo.local_folder"] ||
          containerInfo.config.labels["devcontainer.local_folder"];
        let reattachConfig: Record<string, unknown> | undefined;
        if (configFilePath && workspaceFolderLabel) {
          reattachConfig = await resolveConfigVars(
            workspaceFolderLabel,
            configFilePath,
            undefined,
          );
          if (!reattachConfig) {
            log.warn(
              `devcontainer.json not readable at ${configFilePath}; using probe defaults`,
            );
          }
        }

        await this.serverManager.ensureInstalled(containerId, user);
        const serverInfo = await this.serverManager.start(
          containerId,
          user,
          reattachConfig,
        );

        const localPort = await this.forwardContainerPort(
          containerId,
          serverInfo.port,
          serverInfo.installPath,
        );

        // Port forwarding: one forwarder per resolver, retargeted on re-attach
        // so PortViewProvider's reference stays valid. The server control
        // channel (forwardContainerPort above) is separate from the user-app
        // ports declared via `forwardPorts` in devcontainer.json.
        const nodePath = `${serverInfo.installPath}/node`;
        if (this.portForwarder) {
          await this.portForwarder.retarget(containerId, nodePath);
        } else {
          this.portForwarder = new PortForwarder({ containerId, nodePath });
        }
        if (!this.portViewProvider && this.context) {
          this.portViewProvider = PortViewProvider.register(
            this.context,
            this.portForwarder,
          );
        }
        // Without this the Ports view (`when: artizo.connected` in package.json)
        // never renders.
        void vscode.commands.executeCommand("setContext", "artizo.connected", true);

        // Auto-forward config-declared ports. reattachConfig can be undefined
        // when the container lacks artizo.config_file / artizo.local_folder labels.
        await this.forwardPortsFromConfig(reattachConfig?.forwardPorts);

        // Run user lifecycle hooks after the server is up, in the background.
        // A blocking postAttachCommand must not delay attach. runLifecycleHooks
        // logs its own failures; the catch guards the early (pre-try) path.
        void this.runLifecycleHooks(containerInfo).catch((err: unknown) => {
          log.error(
            `Lifecycle hooks rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        return {
          type: "success",
          authority: {
            host: "127.0.0.1",
            port: localPort,
            connectionToken: serverInfo.connectionToken,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          type: "error",
          message: `Failed to start server in container "${containerId}": ${message}`,
        };
      }
    }

    // Fallback when no server manager is provided (e.g., in tests)
    return {
      type: "success",
      authority: {
        host: containerId,
        port: 0,
      },
    };
  }

  /**
   * Forward a container port to a random local port.
   */
  private forwardContainerPort(
    containerId: string,
    containerPort: number,
    serverInstallPath: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const nodePath = `${serverInstallPath}/node`;

      const server = net.createServer(
        { pauseOnConnect: true },
        (localSocket) => {
          const child = dockerSpawn(
            this.dockerPathOverride ?? getDockerPath(),
            [
              "exec",
              "-i",
              containerId,
              nodePath,
              "-e",
              tcpRelayScript(containerPort),
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );

          const conn = { socket: localSocket, child };
          this.forwardConnections.add(conn);
          const removeConn = () => this.forwardConnections.delete(conn);
          localSocket.on("close", removeConn);
          child.on("exit", removeConn);

          pipeDockerRelay(child, localSocket);
          localSocket.resume();
        },
      );

      // Reject if the server fails before `listen` resolves; after that the
      // promise is already settled, so reject is a no-op and we just log
      // rather than swallowing the error silently.
      server.on("error", (err) => {
        log.error(`Forward server error: ${err.message}`);
        reject(err);
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        // Single active forward server per resolver (one container per
        // window). A reconnect within the same window closes the prior one.
        if (this.forwardServer) {
          this.forwardServer.close();
        }
        this.forwardServer = server;
        resolve(addr.port);
      });
    });
  }

  /**
   * Forward the ports declared in devcontainer.json. Entries are port
   * numbers or "host:port" strings; object entries are rejected (labels
   * belong in portsAttributes). Never throws: one bad port must not block
   * the rest.
   */
  private async forwardPortsFromConfig(
    forwardPortsRaw: unknown,
  ): Promise<void> {
    const forwarder = this.portForwarder;
    if (!forwarder || !Array.isArray(forwardPortsRaw)) return;

    for (const entry of forwardPortsRaw) {
      // Spec: forwardPorts entries are numbers or "host:port" strings.
      // Object entries (e.g. { port, label }) are rejected here; labels
      // belong in portsAttributes.
      let port: number;
      if (typeof entry === "number") {
        port = entry;
      } else if (typeof entry === "string") {
        // "host:port" — extract the port suffix. The host part names the
        // container interface to bind; Artizo's listener forwards to the
        // container port regardless of host, so only the port is used.
        const match = entry.match(/:(\d+)$/);
        if (!match) {
          log.warn(
            `Skipping forwardPorts entry without :port: ${JSON.stringify(entry)}`,
          );
          continue;
        }
        port = Number(match[1]);
      } else {
        log.warn(
          `Skipping invalid forwardPorts entry (must be a number or "host:port" string): ${JSON.stringify(entry)}`,
        );
        continue;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        log.warn(`Skipping out-of-range forwardPorts port: ${port}`);
        continue;
      }
      try {
        await forwarder.forwardPort(port, port, undefined, "config");
      } catch (err) {
        // EADDRINUSE on the host, or listen failure; surface it so the
        // user knows a configured port is not forwarded, but don't block
        // resolve.
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to forward port ${port}: ${message}`);
        void vscode.window.showWarningMessage(
          `Artizo: could not forward port ${port}: ${message}`,
        );
      }
    }
  }

  /**
   * Wire the Ports view and the `artizo.ports.*` commands in a connected window.
   *
   * The registration in resolveContainerById only runs in the extension host
   * that opens the container. The connected window is a separate extension host
   * where resolve() never runs, so without this the commands are missing and
   * the palette reports `command 'artizo.ports.add' not found`.
   */
  async ensurePortsForAttachedWindow(): Promise<void> {
    if (!this.context) return;
    const authority = (vscode.env as { remoteAuthority?: string })
      .remoteAuthority;
    if (!authority) return;

    let scheme: string;
    let id: string;
    try {
      ({ scheme, id } = decodeAuthority(authority));
    } catch (err) {
      log.error(
        `Failed to decode remote authority for port setup: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const containerId =
      scheme === SCHEME_ATTACHED_CONTAINER
        ? id
        : await this.findContainerByLabel(id);
    if (!containerId) {
      return;
    }

    let nodePath: string | undefined;
    if (this.serverManager) {
      try {
        const installPath = await this.serverManager.getInstallPath?.(containerId);
        if (installPath) nodePath = `${installPath}/node`;
      } catch (err) {
        // Leave undefined: forwarder falls back to `node` on PATH.
        log.warn(
          `Install path unavailable, falling back to node on PATH: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (this.portForwarder) {
      await this.portForwarder.retarget(containerId, nodePath);
    } else {
      this.portForwarder = new PortForwarder({ containerId, nodePath });
    }
    if (!this.portViewProvider) {
      this.portViewProvider = PortViewProvider.register(
        this.context,
        this.portForwarder,
      );
    }
    void vscode.commands.executeCommand("setContext", "artizo.connected", true);

    // The forwarder in the window that resolved the authority died with that
    // extension host, so re-forward the configured ports here.
    try {
      const containerInfo = await dockerInspect(containerId, {
        dockerPath: this.dockerPathOverride ?? getDockerPath(),
      });
      const configFilePath =
        containerInfo.config.labels["artizo.config_file"] ||
        containerInfo.config.labels["devcontainer.config_file"];
      const workspaceFolderLabel =
        containerInfo.config.labels["artizo.local_folder"] ||
        containerInfo.config.labels["devcontainer.local_folder"];
      if (configFilePath && workspaceFolderLabel) {
        const reattachConfig = await resolveConfigVars(
          workspaceFolderLabel,
          configFilePath,
          undefined,
        );
        await this.forwardPortsFromConfig(reattachConfig?.forwardPorts);
      }
    } catch (err) {
      log.error(
        `Could not load config-declared ports for forwarding: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Find a container by its local-folder label.
   *
   * Docker's --filter is AND-only, so we can't OR the artizo.* and
   * devcontainer.* labels in one call. Query each, dedup by ID.
   * Returns the first matching container ID, or undefined.
   */
  async findContainerByLabel(
    workspacePath: string,
  ): Promise<string | undefined> {
    try {
      const ids = new Set<string>();
      for (const label of [
        LABEL_LOCAL_FOLDER_ARTIZO,
        LABEL_LOCAL_FOLDER_SPEC,
      ]) {
        const result = await execFilePromise(this.dockerPathOverride ?? getDockerPath(), [
          "ps",
          "-a",
          "-q",
          "--no-trunc",
          "--filter",
          `label=${label}=${workspacePath}`,
        ]);
        if (result.exitCode !== 0) continue;
        for (const id of result.stdout.trim().split("\n").filter(Boolean)) {
          ids.add(id);
        }
      }
      return ids.size > 0 ? ids.values().next().value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the canonical URI for a remote authority.
   * Returns the URI unchanged. The authority already encodes the target.
   */
  getCanonicalURI(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
}

// execFilePromise is now imported from ../utils/dockerUtils.js

/**
 * Parse the production State 4 proxy payload from an authority id.
 *
 * The id is the hex-decoded JSON object produced by the workspace-side
 * extension (running on the SSH host) when it starts the relay daemon and
 * builds the authority for the new container window. Returns undefined if the
 * id isn't a JSON object with `proxy: true` and the required SSH/relay/token
 * fields, so the resolver can fall through to the local Docker path for
 * States 1-3.
 *
 * Field names match `ProxyAuthorityInfo` (src/remote/containerProxy.ts) so
 * the workspace-side serialization and apex-side deserialization share one
 * typed contract.
 */
function tryParseProxyPayload(id: string): ProxyAuthorityInfo | undefined {
  if (!id.startsWith("{")) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(id) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.proxy !== true) return undefined;
  if (typeof parsed.sshHost !== "string") return undefined;
  if (typeof parsed.sshUser !== "string") return undefined;
  if (typeof parsed.relayPort !== "number") return undefined;
  if (typeof parsed.connectionToken !== "string") return undefined;
  if (typeof parsed.workspacePath !== "string") return undefined;
  // sshPort defaults to 22 for payloads encoded before this field existed.
  const sshPort =
    typeof parsed.sshPort === "number" && parsed.sshPort > 0
      ? parsed.sshPort
      : 22;
  // hostWorkspacePath + sshAuthority are optional (added later).
  const hostWorkspacePath =
    typeof parsed.hostWorkspacePath === "string"
      ? parsed.hostWorkspacePath
      : "";
  const sshAuthority =
    typeof parsed.sshAuthority === "string" ? parsed.sshAuthority : "";
  // containerId / containerPort / installPath are optional (added with the
  // apex-side relay heal). Older payloads omit them; the heal is a no-op.
  const containerId =
    typeof parsed.containerId === "string" ? parsed.containerId : undefined;
  const containerPort =
    typeof parsed.containerPort === "number" && parsed.containerPort > 0
      ? parsed.containerPort
      : undefined;
  const installPath =
    typeof parsed.installPath === "string" ? parsed.installPath : undefined;
  return {
    proxy: true,
    sshHost: parsed.sshHost,
    sshUser: parsed.sshUser,
    sshPort,
    relayPort: parsed.relayPort,
    connectionToken: parsed.connectionToken,
    workspacePath: parsed.workspacePath,
    hostWorkspacePath,
    sshAuthority,
    containerId,
    containerPort,
    installPath,
  };
}

/**
 * Register the remote authority resolver with the VS Code API.
 *
 * Tries the proposed `registerRemoteAuthorityResolver` API first (available in
 * VSCodium with enabledApiProposals). Falls back to command-based resolution
 * if the proposed API is not available.
 *
 * @param context - Extension context for registering disposables
 * @param resolver - The resolver instance to register
 */
export function registerAuthorityResolver(
  context: vscode.ExtensionContext,
  resolver: RemoteAuthorityResolver,
): void {
  const disposable = (vscode.workspace as any).registerRemoteAuthorityResolver(
    "artizo-container",
    {
      resolve(authority: string): Thenable<any> {
        return resolver.resolve(authority).then((result) => {
          if (result.type === "error") {
            throw (vscode as any).RemoteAuthorityResolverError.NotAvailable(
              result.message,
              true,
            );
          }
          return new (vscode as any).ResolvedAuthority(
            result.authority.host,
            result.authority.port,
            result.authority.connectionToken,
          );
        });
      },
      getCanonicalURI(uri: vscode.Uri): vscode.Uri {
        return uri;
      },
    },
  );

  context.subscriptions.push(disposable);

  const disposable2 = (vscode.workspace as any).registerRemoteAuthorityResolver(
    "attached-container",
    {
      resolve(authority: string): Thenable<any> {
        return resolver.resolve(authority).then((result) => {
          if (result.type === "error") {
            throw (vscode as any).RemoteAuthorityResolverError.NotAvailable(
              result.message,
              true,
            );
          }
          return new (vscode as any).ResolvedAuthority(
            result.authority.host,
            result.authority.port,
            result.authority.connectionToken,
          );
        });
      },
      getCanonicalURI(uri: vscode.Uri): vscode.Uri {
        return uri;
      },
    },
  );

  context.subscriptions.push(disposable2);
}
