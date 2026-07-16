/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Server lifecycle manager for the remote extension host (REH) inside
 * dev containers.
 *
 * Path layout mirrors the official VS Code remote extension:
 *
 *   installRoot/serverDataFolderName/
 *   ├── bin/<reh-commit>/   ← installPath (tarball extracts here)
 *   │   ├── bin/<binaryName>
 *   │   ├── node
 *   │   ├── extensions/       ← built-ins (shipped in tarball)
 *   │   ├── product.json      ← REH's own product.json (commit source)
 *   │   └── connection-token
 *   ├── extensions/           ← user-installed extensions
 *   └── data/                 ← server user data (User, Machine, logs)
 *
 * The <reh-commit> is read from the extracted tarball's product.json,
 * NOT from the IDE's product.json. This matters when the REH commit
 * differs from the IDE commit (custom REH builds, vscode-oss using
 * vscodium REH, apex→remote-ssh→devcontainer chains where each hop
 * may have a different commit).
 */

import { randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import type { Host } from "../host/host";
import { type ProductInfo, buildServerDownloadUrl } from "./productInfo";
import { getPlatformAdapter } from "../platform";
import { getLogger } from "../utils/logger";

import { ContainerBootstrap } from "./bootstrap";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ServerInfo {
  commit: string;
  arch: string;
  installPath: string;
  port: number;
  connectionToken?: string;
  pid?: number;
}

export interface IServerManager {
  ensureInstalled(containerId: string): Promise<ServerInfo>;
  start(containerId: string): Promise<ServerInfo>;
  stop(containerId: string): Promise<void>;
  getStatus(containerId: string): Promise<ServerInfo | null>;
  getCompatibleVersion(): string;
  /**
   * Container-side directory for user-installed extensions.
   * Distinct from the server's built-in extensions (shipped in the
   * tarball under bin/<commit>/extensions/). The server discovers
   * this path itself via --server-data-dir; we do NOT pass
   * --extensions-dir.
   */
  getUserExtensionsDir(containerId: string): Promise<string>;
}

export function validateArch(unameArch: string): string {
  const trimmed = unameArch.trim();
  switch (trimmed) {
    case "x86_64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported architecture: "${trimmed}"`);
  }
}

/** Maximum time (ms) to wait for the server to announce its listening port. */
const SERVER_START_TIMEOUT_MS = 30_000;

/** Polling interval (ms) when waiting for the server port announcement. */
const PORT_POLL_INTERVAL_MS = 250;

export function buildStartCommand(params: {
  installPath: string;
  binaryName: string;
  tokenFilePath: string;
  serverDataDir: string;
  telemetryLevel: string;
  logFile: string;
  pidFile: string;
}): string[] {
  const {
    installPath,
    binaryName,
    tokenFilePath,
    serverDataDir,
    telemetryLevel,
    logFile,
    pidFile,
  } = params;

  return [
    "sh",
    "-c",
    `mkdir -m 700 -p "${installPath}" "${serverDataDir}"; ` +
      `export PATH=/tmp/.artizo/bin:$PATH; ` +
      `nohup "${installPath}/bin/${binaryName}" ` +
      `--host 127.0.0.1 ` +
      `--port 0 ` +
      `--connection-token-file "${tokenFilePath}" ` +
      `--server-data-dir "${serverDataDir}" ` +
      `--telemetry-level ${telemetryLevel} ` +
      `--accept-server-license-terms ` +
      `--start-server ` +
      `> "${logFile}" 2>&1 & echo $! > "${pidFile}"`,
  ];
}

export interface ServerManagerOptions {
  dockerPath?: string;
  productInfo?: ProductInfo;
  telemetryLevel?: string;
  extensionPath?: string;
  host: Host;
}

/** Server lifecycle manager implementation. */
export class ServerManager implements IServerManager {
  private readonly dockerPath: string;
  private readonly host: Host;
  private readonly productInfo: ProductInfo;
  private readonly telemetryLevel: string;
  private readonly bootstrap: ContainerBootstrap | null;

  /**
   * Cached REH commit, resolved from the extracted tarball's product.json.
   * Set after installServer() completes, or after resolveServerCommit()
   * discovers an existing install via glob. Falls back to the IDE's
   * product.json commit when no install exists yet.
   */
  private resolvedCommit: string | undefined;

  constructor(options: ServerManagerOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.host = options.host;
    this.productInfo = options?.productInfo ?? {
      commit: "unknown",
      quality: "stable",
      serverApplicationName: "server",
      serverDataFolderName: ".server",
    };
    this.telemetryLevel = options?.telemetryLevel ?? "off";
    this.bootstrap = options?.extensionPath
      ? new ContainerBootstrap({
          dockerPath: this.dockerPath,
          extensionPath: options.extensionPath,
        })
      : null;
  }

  getCompatibleVersion(): string {
    return this.productInfo.commit;
  }

  /**
   * Uses /tmp because it is mandated by FHS, always writable (sticky bit 1777),
   * and works regardless of whether the container runs as root or a non-root user.
   * This avoids fragile home-directory detection across diverse container images.
   */
  async getServerInstallRoot(_containerId: string): Promise<string> {
    getLogger().debug(`[Artizo] getServerInstallRoot...`);
    const adapter = await getPlatformAdapter();
    return adapter.getServerInstallRoot?.() ?? "/tmp";
  }

  /**
   * The server data directory, passed to the server via --server-data-dir.
   * This is installRoot/serverDataFolderName — the root that
   * contains bin/, extensions/, data/, etc. Matches the official
   * extension's tp() (serverDataFolder) and MW() (--server-data-dir).
   */
  private getServerDataDir(installRoot: string): string {
    return pathPosix.join(
      installRoot,
      this.productInfo.serverDataFolderName,
    );
  }

  /**
   * Directory where the REH tarball is extracted (the server binary,
   * node, built-in extensions, and product.json all live here).
   *
   * serverDataDir/bin/<commit> — matches the official extension's
   * doe() function. The commit is the REH's actual commit, NOT the
   * IDE's, so callers must pass through resolveServerCommit() first.
   */
  getInstallPathWithRoot(installRoot: string, commit: string): string {
    return pathPosix.join(
      this.getServerDataDir(installRoot),
      "bin",
      commit,
    );
  }

  private getTokenFilePath(installRoot: string, commit: string): string {
    return pathPosix.join(
      this.getInstallPathWithRoot(installRoot, commit),
      "connection-token",
    );
  }

  /**
   * Container-side directory for user-installed extensions.
   *
   * serverDataDir/extensions — matches the official extension's
   * NW() function. Distinct from built-in extensions at
   * installPath/extensions (inside bin/<commit>/). The server
   * discovers this path itself via --server-data-dir; we do NOT pass
   * --extensions-dir.
   */
  getUserExtensionsDir(containerId: string): Promise<string> {
    return this.getServerInstallRoot(containerId).then((installRoot) =>
      pathPosix.join(this.getServerDataDir(installRoot), "extensions"),
    );
  }

  /**
   * Resolve the actual REH commit from the extracted tarball.
   *
   * Returns the cached value if already resolved (from a prior install
   * or glob). Otherwise globs for product.json under bin/ in the
   * server data dir and reads the commit field. If no install exists
   * or the product.json lacks a commit, falls back to the IDE's commit.
   */
  private async resolveServerCommit(containerId: string): Promise<string> {
    if (this.resolvedCommit) return this.resolvedCommit;

    const installRoot = await this.getServerInstallRoot(containerId);
    const serverDataDir = this.getServerDataDir(installRoot);
    const glob = pathPosix.join(serverDataDir, "bin", "*", "product.json");

    getLogger().debug(`[Artizo] resolveServerCommit: glob ${glob}`);
    const result = await this.host.dockerExec(containerId, [
      "sh",
      "-c",
      `for f in ${glob}; do [ -f "$f" ] && { cat "$f"; break; }; done`,
    ]);

    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const product = JSON.parse(result.stdout);
        if (typeof product.commit === "string" && product.commit) {
          this.resolvedCommit = product.commit;
          getLogger().info(
            `[Artizo] resolveServerCommit: reh commit=${product.commit}`,
          );
          return product.commit;
        }
      } catch {
        // Fall through to IDE commit fallback.
      }
    }

    getLogger().debug(
      `[Artizo] resolveServerCommit: no reh install found, using ide commit`,
    );
    // Cache the fallback too so we don't glob repeatedly. installServer
    // will overwrite this with the actual REH commit when it runs.
    this.resolvedCommit = this.productInfo.commit;
    return this.resolvedCommit;
  }

  async detectArch(containerId: string): Promise<string> {
    getLogger().info(`[Artizo] detectArch: exec uname...`);
    const result = await this.host.dockerExec(containerId, ["uname", "-m"]);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to detect container architecture (exit ${result.exitCode}): ${result.stderr}`,
      );
    }

    return validateArch(result.stdout);
  }

  // No version comparison: if the binary is present, use it.
  // When the IDE updates, the container will be rebuilt anyway.
  async isServerBinaryPresent(containerId: string): Promise<boolean> {
    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);
    const binaryName = this.productInfo.serverApplicationName;
    const binaryPath = pathPosix.join(installPath, "bin", binaryName);
    getLogger().info(`[Artizo] isServerBinaryPresent: test -f ${binaryPath}`);

    const result = await this.host.dockerExec(containerId, [
      "test",
      "-f",
      binaryPath,
    ]);

    return result.exitCode === 0;
  }

  async ensureInstalled(containerId: string): Promise<ServerInfo> {
    getLogger().info(`[Artizo] checking arch...`);
    const arch = await this.detectArch(containerId);
    getLogger().info(`[Artizo] arch=${arch}`);

    const binaryPresent = await this.isServerBinaryPresent(containerId);
    getLogger().info(`[Artizo] binaryPresent=${binaryPresent}`);

    if (!binaryPresent) {
      await this.installServer(containerId, arch);
    }

    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);
    getLogger().info(`[Artizo] installPath=${installPath}`);

    return {
      commit,
      arch,
      installPath,
      port: 0,
    };
  }

  private async installServer(
    containerId: string,
    arch: string,
  ): Promise<void> {
    if (!this.bootstrap) {
      throw new Error(
        "ServerManager has no bootstrap, extensionPath not provided",
      );
    }

    const url = await buildServerDownloadUrl(this.productInfo, arch);
    getLogger().info(`[Artizo] installServer: url=${url}`);
    const installRoot = await this.getServerInstallRoot(containerId);
    const serverDataDir = this.getServerDataDir(installRoot);

    // Extract to a staging directory first so we can read the actual REH
    // commit from product.json before moving to the final bin/<commit>/
    // path. The staging dir is under serverDataDir so the mv is a rename
    // (same filesystem, atomic).
    const stagingDir = pathPosix.join(
      serverDataDir,
      `.staging-${randomUUID()}`,
    );

    getLogger().info(`[Artizo] staging at ${stagingDir}`);
    await this.host.dockerExec(containerId, [
      "rm",
      "-rf",
      stagingDir,
    ]);

    getLogger().info(`[Artizo] deploying busybox...`);
    await this.bootstrap.bootstrapBusybox(containerId, arch);

    getLogger().info(`[Artizo] deploying tools...`);
    await this.bootstrap.deployTools(containerId);

    const adapter = await getPlatformAdapter();
    const authToken = adapter.readAuthToken?.();
    const authTokenPath = adapter.getAuthTokenPath?.();

    getLogger().info(`[Artizo] running setup (${url})...`);
    await this.bootstrap.runSetup(
      containerId,
      url,
      stagingDir,
      authToken,
      authTokenPath,
    );
    getLogger().info(`[Artizo] setup done`);

    // Read the actual REH commit from the extracted product.json.
    // This is the commit the tarball was built with, which may differ
    // from the IDE's commit (custom REH, vscode-oss using vscodium REH,
    // etc.). Falls back to the IDE's commit if missing.
    const productResult = await this.host.dockerExec(containerId, [
      "cat",
      pathPosix.join(stagingDir, "product.json"),
    ]);

    let rehCommit = this.productInfo.commit;
    if (productResult.exitCode === 0 && productResult.stdout.trim()) {
      try {
        const product = JSON.parse(productResult.stdout);
        if (typeof product.commit === "string" && product.commit) {
          rehCommit = product.commit;
        }
      } catch {
        // Fall through to IDE commit fallback.
      }
    }

    this.resolvedCommit = rehCommit;
    getLogger().info(`[Artizo] reh commit=${rehCommit}`);

    // Move staging to the final bin/<commit>/ path.
    const finalDir = this.getInstallPathWithRoot(installRoot, rehCommit);
    getLogger().info(`[Artizo] moving to ${finalDir}`);
    await this.host.dockerExec(containerId, [
      "sh",
      "-c",
      `rm -rf "${finalDir}" && mkdir -p "${pathPosix.dirname(finalDir)}" && mv "${stagingDir}" "${finalDir}"`,
    ]);
  }

  /**
   * Create or read the connection token file atomically.
   *
   * Uses umask 377 for restrictive permissions (0400) and mv -n for
   * race-condition safety.
   */
  async ensureConnectionToken(containerId: string): Promise<string> {
    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const tokenPath = this.getTokenFilePath(installRoot, commit);
    const uuid = randomUUID();

    const tokenCmd = [
      "sh",
      "-c",
      `cat '${tokenPath}' 2>/dev/null || ` +
        `(umask 377 && echo '${uuid}' >'${tokenPath}-${uuid}' && ` +
        `mv -n '${tokenPath}-${uuid}' '${tokenPath}' && ` +
        `rm -f '${tokenPath}-${uuid}' && cat '${tokenPath}')`,
    ];

    const result = await this.host.dockerExec(containerId, tokenCmd);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create connection token (exit ${result.exitCode}): ${result.stderr}`,
      );
    }

    const token = result.stdout.trim();
    if (!token) {
      throw new Error("Connection token file is empty");
    }

    return token;
  }

  parsePortFromOutput(stdout: string): number {
    const patterns = [
      /Extension host agent listening on (\d+)/,
      /listeningOn:\s*(\d+)/,
      /listening on port (\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = stdout.match(pattern);
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (port > 0) {
          return port;
        }
      }
    }

    return 0;
  }

  /**
   * Start the server in the container.
   *
   * Launches the server binary in the background using nohup/setsid,
   * redirecting stdout to a log file. Then polls the log file until the
   * server announces its listening port.
   */
  async start(containerId: string): Promise<ServerInfo> {
    const arch = await this.detectArch(containerId);
    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const connectionToken = await this.ensureConnectionToken(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);
    const tokenFilePath = this.getTokenFilePath(installRoot, commit);
    const serverDataDir = this.getServerDataDir(installRoot);
    const binaryName = this.productInfo.serverApplicationName;
    const logFile = pathPosix.join(installPath, "server.log");
    const pidFile = pathPosix.join(installPath, "server.pid");

    await this.stop(containerId);

    const startCmd = buildStartCommand({
      installPath,
      binaryName,
      tokenFilePath,
      serverDataDir,
      telemetryLevel: this.telemetryLevel,
      logFile,
      pidFile,
    });

    const startResult = await this.host.dockerExec(containerId, startCmd);

    if (startResult.exitCode !== 0) {
      throw new Error(
        `Failed to start server (exit ${startResult.exitCode}): ${startResult.stderr}`,
      );
    }

    const port = await this.waitForPort(containerId, logFile);

    if (port === 0) {
      const logResult = await this.host.dockerExec(containerId, [
        "cat",
        logFile,
      ]);
      throw new Error(
        `Server did not announce a listening port within ${SERVER_START_TIMEOUT_MS}ms. ` +
          `Log output:\n${logResult.stdout}\n${logResult.stderr}`,
      );
    }

    return {
      commit,
      arch,
      installPath,
      port,
      connectionToken,
    };
  }

  private async waitForPort(
    containerId: string,
    logFile: string,
  ): Promise<number> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await this.host.dockerExec(containerId, ["cat", logFile]);

      if (result.exitCode === 0 && result.stdout) {
        const port = this.parsePortFromOutput(result.stdout);
        if (port > 0) {
          return port;
        }

        // Check if the server crashed (process exited with error in log)
        if (
          result.stdout.includes("EADDRINUSE") ||
          result.stdout.includes("Error:")
        ) {
          return 0;
        }
      }

      await sleep(PORT_POLL_INTERVAL_MS);
    }

    return 0;
  }

  async stop(containerId: string): Promise<void> {
    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);
    const binaryName = this.productInfo.serverApplicationName;
    const pidFile = pathPosix.join(installPath, "server.pid");

    const pidResult = await this.host.dockerExec(containerId, ["cat", pidFile]);

    if (pidResult.exitCode === 0 && pidResult.stdout.trim()) {
      const pid = pidResult.stdout.trim();
      await this.host.dockerExec(containerId, ["kill", "-TERM", pid]);
      await this.host.dockerExec(containerId, ["rm", "-f", pidFile]);
      return;
    }

    const findResult = await this.host.dockerExec(containerId, [
      "pgrep",
      "-f",
      `${binaryName}.*--connection-token-file`,
    ]);

    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return;
    }

    const pids = findResult.stdout.trim().split("\n").filter(Boolean);

    for (const pid of pids) {
      await this.host.dockerExec(containerId, ["kill", "-TERM", pid]);
    }
  }

  async getStatus(containerId: string): Promise<ServerInfo | null> {
    const binaryName = this.productInfo.serverApplicationName;

    // Check if the server process is running
    const findResult = await this.host.dockerExec(containerId, [
      "pgrep",
      "-f",
      `${binaryName}.*--connection-token-file`,
    ]);

    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return null;
    }

    const pid = parseInt(findResult.stdout.trim().split("\n")[0], 10);

    let arch: string;
    try {
      arch = await this.detectArch(containerId);
    } catch {
      arch = "unknown";
    }

    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);

    return {
      commit,
      arch,
      installPath,
      port: 0,
      pid: isNaN(pid) ? undefined : pid,
    };
  }
}
