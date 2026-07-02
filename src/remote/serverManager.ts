/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Server lifecycle manager for kiro-reh inside containers. */

import { randomUUID } from "node:crypto";
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
   * Container-side extensions directory for this platform's server.
   * Used by ExtensionInstaller to know where to unzip VSIXs, and
   * passed to the server via --extensions-dir on start.
   */
  getExtensionsDir(containerId: string): Promise<string>;
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
  extensionsDir: string;
  telemetryLevel: string;
  logFile: string;
  pidFile: string;
}): string[] {
  const {
    installPath,
    binaryName,
    tokenFilePath,
    serverDataDir,
    extensionsDir,
    telemetryLevel,
    logFile,
    pidFile,
  } = params;

  return [
    "sh",
    "-c",
    `mkdir -m 700 -p "${installPath}" "${serverDataDir}" "${extensionsDir}"; ` +
      `export PATH=/tmp/.artizo/bin:$PATH; ` +
      `nohup "${installPath}/bin/${binaryName}" ` +
      `--host 127.0.0.1 ` +
      `--port 0 ` +
      `--connection-token-file "${tokenFilePath}" ` +
      `--server-data-dir "${serverDataDir}" ` +
      `--extensions-dir "${extensionsDir}" ` +
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
  host?: Host;
}

/** Server lifecycle manager implementation. */
export class ServerManager implements IServerManager {
  private readonly dockerPath: string;
  private readonly host: Host;
  private readonly productInfo: ProductInfo;
  private readonly telemetryLevel: string;
  private readonly bootstrap: ContainerBootstrap | null;

  constructor(options?: ServerManagerOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.host = options?.host!;
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
    getLogger().info(`[Artizo] getServerInstallRoot...`);
    const adapter = await getPlatformAdapter();
    return adapter.getServerInstallRoot?.() ?? "/tmp";
  }

  // No commit hash in path; avoids stale-container mismatches.
  // Version tracking is done via a .version file inside this directory.
  getInstallPathWithRoot(installRoot: string): string {
    return `${installRoot}/${this.productInfo.serverDataFolderName}`;
  }

  private getTokenFilePath(installRoot: string): string {
    return `${this.getInstallPathWithRoot(installRoot)}/connection-token`;
  }

  private getServerDataDir(installRoot: string): string {
    return `${installRoot}/${this.productInfo.serverDataFolderName}/data`;
  }

  /**
   * Container-side extensions directory.
   *
   * `${installRoot}/${serverDataFolderName}/extensions` - matches
   * the `.<name>-server/extensions` convention used by each platform's
   * remote extension host.
   */
  getExtensionsDir(containerId: string): Promise<string> {
    return this.getServerInstallRoot(containerId).then(
      (installRoot) =>
        `${installRoot}/${this.productInfo.serverDataFolderName}/extensions`,
    );
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
    const installPath = this.getInstallPathWithRoot(installRoot);
    const binaryName = this.productInfo.serverApplicationName;
    const binaryPath = `${installPath}/bin/${binaryName}`;
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
    const installRoot = await this.getServerInstallRoot(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot);
    getLogger().info(`[Artizo] installPath=${installPath}`);

    const binaryPresent = await this.isServerBinaryPresent(containerId);
    getLogger().info(`[Artizo] binaryPresent=${binaryPresent}`);

    if (!binaryPresent) {
      await this.installServer(containerId, arch);
    }

    return {
      commit: this.productInfo.commit,
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
    const installPath = this.getInstallPathWithRoot(installRoot);

    getLogger().info(`[Artizo] clean install, path=${installPath}`);

    await this.host.dockerExec(containerId, ["rm", "-rf", installPath]);

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
      installPath,
      authToken,
      authTokenPath,
    );
    getLogger().info(`[Artizo] setup done`);
  }

  /**
   * Create or read the connection token file atomically.
   *
   * Uses umask 377 for restrictive permissions (0400) and mv -n for
   * race-condition safety.
   */
  async ensureConnectionToken(containerId: string): Promise<string> {
    const installRoot = await this.getServerInstallRoot(containerId);
    const tokenPath = this.getTokenFilePath(installRoot);
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
    const connectionToken = await this.ensureConnectionToken(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot);
    const tokenFilePath = this.getTokenFilePath(installRoot);
    const serverDataDir = this.getServerDataDir(installRoot);
    const extensionsDir = await this.getExtensionsDir(containerId);
    const binaryName = this.productInfo.serverApplicationName;
    const logFile = `${installPath}/server.log`;
    const pidFile = `${installPath}/server.pid`;

    await this.stop(containerId);

    const startCmd = buildStartCommand({
      installPath,
      binaryName,
      tokenFilePath,
      serverDataDir,
      extensionsDir,
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
      commit: this.productInfo.commit,
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
    const installPath = this.getInstallPathWithRoot(installRoot);
    const binaryName = this.productInfo.serverApplicationName;
    const pidFile = `${installPath}/server.pid`;

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
    const installPath = this.getInstallPathWithRoot(installRoot);

    return {
      commit: this.productInfo.commit,
      arch,
      installPath,
      port: 0,
      pid: isNaN(pid) ? undefined : pid,
    };
  }
}
