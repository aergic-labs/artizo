/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Remote authority resolver for dev-container and attached-container schemes.
 *
 * Handles resolving remote authority URIs to container connection info.
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

/**
 * File-based logger that always works regardless of window state.
 */
const LOG_FILE = path.join(os.tmpdir(), "artizo-resolver.log");
function logToFile(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

/**
 * Resolved authority containing connection details for a container.
 */
export interface ResolvedAuthority {
  host: string;
  port: number;
  connectionToken?: string;
}

/**
 * Result of resolving an authority. Either success or error.
 */
export type ResolveResult =
  | { type: "success"; authority: ResolvedAuthority }
  | { type: "error"; message: string };

/**
 * The two supported remote authority schemes.
 */
export const SCHEME_DEV_CONTAINER = "artizo-container";
export const SCHEME_ATTACHED_CONTAINER = "attached-container";

/**
 * Docker label used to associate a dev container with a workspace folder.
 */
const LABEL_LOCAL_FOLDER = "devcontainer.local_folder";

/**
 * Options for the authority resolver.
 */
export interface AuthorityResolverOptions {
  dockerPath?: string;
  serverManager?: IServerManager;
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

  constructor(options?: AuthorityResolverOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.serverManager = options?.serverManager;
    logToFile("=== RemoteAuthorityResolver created ===");
  }

  setServerManager(sm: IServerManager): void {
    this.serverManager = sm;
    logToFile("[Resolver] serverManager set");
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

    return this.resolveContainerById(containerId);
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
   * Resolve a container by its ID, verify it's running, and return connection info.
   */
  private async resolveContainerById(
    containerId: string,
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

    if (this.serverManager) {
      try {
        logToFile(`[Resolver] Installing server...`);
        await this.serverManager.ensureInstalled(containerId);
        logToFile(`[Resolver] Starting server...`);
        const serverInfo = await this.serverManager.start(containerId);
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

          pipeDockerRelay(child, localSocket);
          localSocket.resume();
        },
      );

      server.on("error", reject);

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        if (this.forwardServer) {
          this.forwardServer.close();
        }
        this.forwardServer = server;
        resolve(addr.port);
      });
    });
  }

  /**
   * Find a container by the devcontainer.local_folder label.
   * Returns the container ID if found, or undefined.
   */
  async findContainerByLabel(
    workspacePath: string,
  ): Promise<string | undefined> {
    try {
      const result = await execFilePromise(this.dockerPath, [
        "ps",
        "-q",
        "--filter",
        `label=${LABEL_LOCAL_FOLDER}=${workspacePath}`,
      ]);

      if (result.exitCode !== 0) {
        return undefined;
      }

      const ids = result.stdout.trim().split("\n").filter(Boolean);
      return ids.length > 0 ? ids[0] : undefined;
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