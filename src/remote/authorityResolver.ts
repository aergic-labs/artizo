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
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { decodeAuthority } from "../utils/uriUtils";
import {
  dockerInspect,
  type ContainerInfo,
  execFilePromise,
  dockerSpawn,
  tcpRelayScript,
  pipeDockerRelay,
} from "../utils/dockerUtils";
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
import { URI } from "vscode-uri";
import { buildIdentityLabels } from "../workflows/postLaunch";
import { getPlatformAdapter } from "../platform";

/** File-based logger that works regardless of window state. */
const LOG_FILE = path.join(os.tmpdir(), "artizo-resolver.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logSizeChecked = false;
function logToFile(msg: string): void {
  try {
    // Bound growth: truncate once per process if the file got large across
    // prior sessions. This is a diagnostic log, not an audit trail.
    if (!logSizeChecked) {
      logSizeChecked = true;
      try {
        if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
          fs.truncateSync(LOG_FILE, 0);
        }
      } catch {
        /* no existing file */
      }
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* diagnostics only: never throw from the resolve path */
  }
}

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
  private readonly dockerPath: string;
  private serverManager: IServerManager | undefined;
  private forwardServer: net.Server | undefined;
  /** Active sockets + docker exec children from forwardContainerPort. */
  private readonly forwardConnections: Set<{ socket: net.Socket; child: import("node:child_process").ChildProcess }> = new Set();
  /** Extension install path (for locating bundled askpass scripts). */
  private readonly extensionPath: string | undefined;
  /**
   * Active SSH tunnels keyed by the local port returned to VS Code. Allows
   * `dispose()` to tear down tunnels (and stop respawn) on extension
   * deactivation.
   */
  private readonly tunnels: Map<number, TunnelController> = new Map();

  constructor(options?: AuthorityResolverOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.serverManager = options?.serverManager;
    this.extensionPath = options?.extensionPath;
    logToFile("=== RemoteAuthorityResolver created ===");
  }

  setServerManager(sm: IServerManager): void {
    this.serverManager = sm;
    logToFile("[Resolver] serverManager set");
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
  }

  /**
   * Resolve a remote authority URI to connection info.
   *
   * @param authority - The full authority string (e.g., "artizo-container+7265706f")
   * @returns Resolve result with connection info or error
   */
  async resolve(authority: string): Promise<ResolveResult> {
    logToFile(`[Resolver] resolve() called with authority: ${authority}`);

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
    logToFile(`[Resolver] trying getRemoteExecServer for authority: ${sshAuthority}`);
    try {
      const getExecServer = (vscode.workspace as unknown as {
        getRemoteExecServer?: (authority: string) => Promise<ExecServerLike | undefined>;
      }).getRemoteExecServer;
      if (typeof getExecServer !== "function") {
        logToFile("[Resolver] getRemoteExecServer API not available (not a function)");
        return undefined;
      }
      const execServer = await getExecServer.call(vscode.workspace, sshAuthority);
      if (execServer) {
        const hasSpawn = typeof execServer.spawn === "function";
        const hasTcpConnect = typeof execServer.tcpConnect === "function";
        const hasFs = !!execServer.fs;
        logToFile(
          `[Resolver] ExecServer available: spawn=${hasSpawn} tcpConnect=${hasTcpConnect} fs=${hasFs}`,
        );
        if (!hasTcpConnect) {
          logToFile("[Resolver] ExecServer has no tcpConnect, cannot use for bridge");
          return undefined;
        }
        return execServer;
      }
      logToFile("[Resolver] getRemoteExecServer returned undefined (resolver does not implement resolveExecServer)");
    } catch (err: unknown) {
      logToFile(
        `[Resolver] getRemoteExecServer threw: ${err instanceof Error ? err.message : String(err)}`,
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
        logToFile("[remote-check] no hostWorkspacePath in payload, skipping");
        return "ok";
      }
      const { remoteFindContainer } = await import("./configCheckRemote.js");
      const containerId = await remoteFindContainer(
        execServer,
        proxy.hostWorkspacePath,
        logToFile,
      );
      if (!containerId) {
        logToFile("[remote-check] no container found on host, skipping");
        return "ok";
      }
      const outcome = await checkContainerConfigRemote(
        execServer,
        containerId,
        logToFile,
      );
      if (outcome.kind === "changed") {
        const action = await vscode.window.showWarningMessage(
          `Container config has changed: ${outcome.files.join(", ")}. To rebuild, open the folder on the SSH host and run 'Artizo: Rebuild Container'.`,
          "Continue anyway",
        );
        logToFile(
          `[remote-check] user chose ${action === "Continue anyway" ? "Continue anyway" : "dismissed"} (mismatch)`,
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
        logToFile(`[remote-check] skipped: ${outcome.reason}`);
      }
      return "ok";
    } catch (err: unknown) {
      logToFile(
        `[remote-check] failed: ${err instanceof Error ? err.message : String(err)}`,
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
    logToFile(
      `[Resolver] proxy payload: ssh=${proxy.sshUser}@${proxy.sshHost} relayPort=${proxy.relayPort} token=${proxy.connectionToken} workspace=${proxy.workspacePath}`,
    );

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
      logToFile(`[Resolver] using ExecServer bridge for relayPort=${proxy.relayPort}`);
      try {
        const controller = await startExecServerBridge(
          execServer,
          "127.0.0.1",
          proxy.relayPort,
        );
        const localPort = controller.localPort;
        this.tunnels.set(localPort, controller);
        logToFile(
          `[Resolver] execServer bridge up: 127.0.0.1:${localPort} -> 127.0.0.1:${proxy.relayPort} (via ExecServer)`,
        );
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
        logToFile(`[Resolver] execServer bridge failed: ${message}`);
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
    logToFile("[Resolver] ExecServer unavailable, falling back to ssh -L tunnel");
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
        logToFile(
          `[Resolver] tunnel up: 127.0.0.1:${localPort} -> ${proxy.sshUser}@${proxy.sshHost}:127.0.0.1:${proxy.relayPort}`,
        );
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
        logToFile(`[Resolver] proxy tunnel failed: ${message}`);
        // Evict host passwords so a retry re-prompts instead of reusing
        // a bad password.
        if (askpass?.server.usedHostPassword) {
          logToFile("[Resolver] evicting host password cache entries");
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
      logToFile(
        "[Resolver] No workspace folder label; skipping lifecycle hooks",
      );
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
        log: (text: string) => logToFile(`[Resolver] [lifecycle] ${text}`),
      });

      logToFile(`[Resolver] Running lifecycle hooks via CLI...`);
      const result = await launchProvision(
        options,
        configPath,
        undefined,
        idLabels,
      );
      logToFile(`[Resolver] Lifecycle hooks complete`);
      // Finish any background tasks the CLI started (e.g. non-blocking hooks).
      if (result?.finishBackgroundTasks) {
        await result.finishBackgroundTasks();
      }
    } catch (err: unknown) {
      // Best-effort: don't block the resolve if hooks fail. The server
      // can still start without them.
      const message = err instanceof Error ? err.message : String(err);
      logToFile(`[Resolver] Lifecycle hooks failed (non-blocking): ${message}`);
    }
  }

  /**
   * Resolve a container by its ID, verify it's running, and return connection info.
   */
  private async resolveContainerById(
    containerId: string,
    options?: { checkConfig?: boolean },
  ): Promise<ResolveResult> {
    logToFile(`[Resolver] resolveContainerById: ${containerId}`);
    let containerInfo: ContainerInfo;
    try {
      containerInfo = await dockerInspect(containerId, {
        dockerPath: this.dockerPath,
      });
      logToFile(`[Resolver] Container state: ${containerInfo.state.status}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logToFile(`[Resolver] ERROR inspecting container: ${message}`);
      return {
        type: "error",
        message: `Failed to inspect container "${containerId}": ${message}`,
      };
    }

    if (!containerInfo.state.running) {
      logToFile(`[Resolver] Container not running`);
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
        // Run lifecycle hooks (postStartCommand, postAttachCommand) via
        // the CLI before installing the server. One-time hooks
        // (onCreateCommand, etc.) are skipped by the CLI's marker logic.
        // Labels on the container carry the workspace folder + config path,
        // both local to wherever this resolver runs (apex for local,
        // remote-ssh host for dual-hop — same side that has Docker).
        await this.runLifecycleHooks(containerInfo);

        // Recover remoteUser (from our label) and containerUser (from
        // Config.User) so re-attach runs install/start as the right user
        // instead of defaulting to root. Both come from the existing
        // dockerInspect call above — no new docker calls.
        const remoteUser =
          containerInfo.config.labels["artizo.remote_user"];
        const containerUser =
          containerInfo.config.user &&
          containerInfo.config.user !== "root"
            ? containerInfo.config.user
            : undefined;
        const user = remoteUser || containerUser;

        logToFile(`[Resolver] Ensuring server is installed...`);
        await this.serverManager.ensureInstalled(containerId, user);
        logToFile(`[Resolver] Starting server...`);
        const serverInfo = await this.serverManager.start(
          containerId,
          user,
        );
        logToFile(
          `[Resolver] Server started on container port ${serverInfo.port}`,
        );

        logToFile(`[Resolver] Forwarding port...`);
        const localPort = await this.forwardContainerPort(
          containerId,
          serverInfo.port,
          serverInfo.installPath,
        );
        logToFile(`[Resolver] Forwarded to local port ${localPort}`);

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
        logToFile(`[Resolver] ERROR: ${message}`);
        return {
          type: "error",
          message: `Failed to start server in container "${containerId}": ${message}`,
        };
      }
    }

    logToFile(`[Resolver] No serverManager, returning fallback`);
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
            this.dockerPath,
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
        logToFile(`[Resolver] forward server error: ${err.message}`);
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
        const result = await execFilePromise(this.dockerPath, [
          "ps",
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
  logToFile("[Register] Registering remote authority resolvers");

  const disposable = (vscode.workspace as any).registerRemoteAuthorityResolver(
    "artizo-container",
    {
      resolve(authority: string): Thenable<any> {
        logToFile(`[Resolver] resolve() called, authority=${authority}`);
        return resolver.resolve(authority).then((result) => {
          if (result.type === "error") {
            logToFile(`[Resolver] error: ${result.message}`);
            throw (vscode as any).RemoteAuthorityResolverError.NotAvailable(
              result.message,
              true,
            );
          }
          logToFile(
            `[Resolver] success: ${result.authority.host}:${result.authority.port}`,
          );
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
        logToFile(
          `[Resolver] resolve() called for attached-container, authority=${authority}`,
        );
        return resolver.resolve(authority).then((result) => {
          if (result.type === "error") {
            logToFile(`[Resolver] error: ${result.message}`);
            throw (vscode as any).RemoteAuthorityResolverError.NotAvailable(
              result.message,
              true,
            );
          }
          logToFile(
            `[Resolver] success: ${result.authority.host}:${result.authority.port}`,
          );
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
  logToFile("[Register] Both resolvers registered OK");
}
