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
 *   |-- bin/<reh-commit>/   <- installPath (tarball extracts here)
 *   |   |-- bin/<binaryName>
 *   |   |-- node
 *   |   |-- extensions/       <- built-ins (shipped in tarball)
 *   |   |-- product.json      <- REH's own product.json (commit source)
 *   |   `-- connection-token
 *   |-- extensions/           <- user-installed extensions
 *   `-- data/                 <- server user data (User, Machine, logs)
 *
 * The <reh-commit> is read from the extracted tarball's product.json,
 * NOT from the IDE's product.json. This matters when the REH commit
 * differs from the IDE commit (custom REH builds, vscode-oss using
 * vscodium REH, apex->remote-ssh->devcontainer chains where each hop
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

/**
 * Validate a user value before it reaches `docker exec -u <value>`
 * or `docker run -u <value>`. The value is user-controlled (from
 * `devcontainer.json` `remoteUser` or `containerUser`) and passed as a
 * raw argv element. Without validation, values like `--privileged` or
 * `--user=root` could be interpreted by docker as flags rather than the
 * `-u` argument.
 *
 * Accepts:
 * - POSIX username: `^[a-z_][a-z0-9_-]*$` (IEEE Std 1003.1)
 * - Numeric uid: `^\d+$`
 * - Numeric uid:gid: `^\d+:\d+$`
 *
 * Rejects anything else, including empty strings, values starting
 * with `-`, and strings with shell metacharacters.
 */
export function isValidDockerUser(value: string): boolean {
  return /^[a-z_][a-z0-9_-]*$/.test(value) || /^\d+(:\d+)?$/.test(value);
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
  ensureInstalled(containerId: string, remoteUser?: string): Promise<ServerInfo>;
  start(containerId: string, remoteUser?: string): Promise<ServerInfo>;
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
  /**
   * Check if remoteUser exists in the container. Cached per container.
   * Returns the remoteUser if it exists (or is empty/numeric), undefined
   * if it doesn't (fallback to containerUser). When called without
   * remoteUser, returns the cached value from a prior call (if any).
   */
  preflightRemoteUser(containerId: string, remoteUser?: string): Promise<string | undefined>;
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

export type ProbeStatus =
  | "none"
  | "dead"
  | "noport"
  | "unresponsive"
  | "reuse";

export interface ProbeResult {
  status: ProbeStatus;
  pid?: string;
  port?: number;
}

/** Parse the probe script's stdout into a ProbeResult. Pure; exported for tests. */
export function parseProbeOutput(out: string): ProbeResult {
  const trimmed = out.trim();
  if (trimmed.startsWith("REUSE:")) {
    const [, pid, portStr] = trimmed.split(":");
    const port = parseInt(portStr, 10);
    if (pid && !isNaN(port) && port > 0) {
      return { status: "reuse", pid, port };
    }
    return { status: "none" };
  }
  if (trimmed.startsWith("DEAD:")) {
    return { status: "dead", pid: trimmed.slice(5) || undefined };
  }
  if (trimmed.startsWith("NOPORT:")) {
    return { status: "noport", pid: trimmed.slice(7) || undefined };
  }
  if (trimmed.startsWith("UNRESPONSIVE:")) {
    const [, pid, portStr] = trimmed.split(":");
    const port = parseInt(portStr, 10);
    return {
      status: "unresponsive",
      pid: pid || undefined,
      port: isNaN(port) ? undefined : port,
    };
  }
  return { status: "none" };
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
  /** Cached container arch. Avoids re-running `uname -m` on every start. */
  private resolvedArch: string | undefined;
  /** Cached remoteUser preflight result per container: { user, exists }. */
  private remoteUserChecked = new Map<string, { user: string; exists: boolean }>();

  constructor(options: ServerManagerOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.host = options.host;
    this.productInfo = options?.productInfo ?? {
      commit: "unknown",
      quality: "stable",
      version: "",
      release: "unknown",
      serverApplicationName: "server",
      serverDataFolderName: ".server",
      verifyChecksum: false,
      onNoChecksum: "warn",
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
    getLogger().debug(`[install] getServerInstallRoot...`);
    const adapter = await getPlatformAdapter();
    return adapter.getServerInstallRoot?.() ?? "/tmp";
  }

  /**
   * The server data directory, passed to the server via --server-data-dir.
   * This is installRoot/serverDataFolderName, the root that
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
   * serverDataDir/bin/<commit> matches the official extension's
   * convention. The commit is the IDE's commit (product.json commit
   * is patched to match after extraction when it differs).
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
   * serverDataDir/extensions matches the official extension's
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

    // Look for an existing install at bin/<ide-commit>/product.json.
    // The dir is named after the IDE commit (matching the official
    // extension), and the product.json commit is patched to match.
    const installRoot = await this.getServerInstallRoot(containerId);
    const serverDataDir = this.getServerDataDir(installRoot);
    const glob = pathPosix.join(serverDataDir, "bin", "*", "product.json");

    getLogger().debug(`[install] resolveServerCommit: glob ${glob}`);
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
            `[install] resolveServerCommit: commit=${product.commit}`,
          );
          return product.commit;
        }
      } catch {
        // Fall through to IDE commit fallback.
      }
    }

    getLogger().debug(
      `[install] resolveServerCommit: no install found, using ide commit`,
    );
    this.resolvedCommit = this.productInfo.commit;
    return this.resolvedCommit;
  }

  async detectArch(containerId: string): Promise<string> {
    if (this.resolvedArch) return this.resolvedArch;
    getLogger().debug(`[install] detectArch: exec uname...`);
    const result = await this.host.dockerExec(containerId, ["uname", "-m"]);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to detect container architecture (exit ${result.exitCode}): ${result.stderr}`,
      );
    }

    this.resolvedArch = validateArch(result.stdout);
    return this.resolvedArch;
  }

  // No version comparison: if the binary is present, use it.
  // When the IDE updates, the container will be rebuilt anyway.
  async isServerBinaryPresent(containerId: string): Promise<boolean> {
    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);
    const binaryName = this.productInfo.serverApplicationName;
    const binaryPath = pathPosix.join(installPath, "bin", binaryName);
    getLogger().debug(`[install] isServerBinaryPresent: test -f ${binaryPath}`);

    const result = await this.host.dockerExec(containerId, [
      "test",
      "-f",
      binaryPath,
    ]);

    return result.exitCode === 0;
  }

  /**
   * Single-call probe: container arch, REH commit from an existing
   * install's product.json, and whether the server binary is present.
   * Replaces the prior 3-call sequence (detectArch + resolveServerCommit
   * + isServerBinaryPresent). Output is `:::`-delimited to avoid JSON
   * escaping issues with paths.
   */
  private async probeContainer(containerId: string): Promise<{
    arch: string;
    commit: string;
    binaryPresent: boolean;
  }> {
    const installRoot = await this.getServerInstallRoot(containerId);
    const serverDataDir = this.getServerDataDir(installRoot);
    const glob = pathPosix.join(serverDataDir, "bin", "*", "product.json");
    const binaryName = this.productInfo.serverApplicationName;

    const cmd =
      `a=$(uname -m); ` +
      `c=$(for f in ${glob}; do [ -f "$f" ] && { sed -n 's/.*"commit": "\\([0-9a-f]*\\)".*/\\1/p' "$f"; break; }; done); ` +
      `[ -n "$c" ] || c="${this.productInfo.commit}"; ` +
      `p=no; [ -f "${serverDataDir}/bin/$c/bin/${binaryName}" ] && p=yes; ` +
      `printf '%s:::%s:::%s\\n' "$a" "$c" "$p"`;

    getLogger().debug(`[install] probeContainer: ${cmd}`);
    const result = await this.host.dockerExec(containerId, [
      "sh",
      "-c",
      cmd,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Container probe failed (exit ${result.exitCode}): ${result.stderr || result.stdout.slice(0, 200)}`,
      );
    }

    const parts = result.stdout.trim().split(":::");
    if (parts.length < 3) {
      throw new Error(
        `Container probe: malformed output (expected 3 fields, got ${parts.length}): ${result.stdout.slice(0, 200)}`,
      );
    }

    const arch = validateArch(parts[0].trim());
    const commit = parts[1].trim() || this.productInfo.commit;
    const binaryPresent = parts[2].trim() === "yes";

    // Cache for subsequent resolveServerCommit / detectArch calls.
    this.resolvedArch = arch;
    this.resolvedCommit = commit;

    return { arch, commit, binaryPresent };
  }

  async preflightRemoteUser(containerId: string, remoteUser?: string): Promise<string | undefined> {
    // No remoteUser provided — return cached value (for resolver re-attach path)
    if (!remoteUser) {
      const cached = this.remoteUserChecked.get(containerId);
      return cached?.exists ? cached.user : undefined;
    }
    // Validate before any docker exec. remoteUser is user-controlled
    // (devcontainer.json) and reaches `docker exec -u <user>` as a raw
    // argv element. Reject anything that isn't a POSIX username, a
    // numeric uid, or a uid:gid pair — prevents argument injection
    // (e.g. "--privileged") and garbage from crashing docker or worse.
    if (!isValidDockerUser(remoteUser)) {
      getLogger().warn(
        `[remote-user] remoteUser "${remoteUser}" is not a valid username or uid; ignoring.`,
      );
      return undefined;
    }
    // Numeric (uid or uid:gid) — Docker accepts these, no need to check existence
    if (/^\d+(:\d+)?$/.test(remoteUser)) {
      this.remoteUserChecked.set(containerId, { user: remoteUser, exists: true });
      return remoteUser;
    }
    // Check cache — if same user already preflighted, return cached result
    const cached = this.remoteUserChecked.get(containerId);
    if (cached?.user === remoteUser) {
      return cached.exists ? cached.user : undefined;
    }
    // Run preflight: getent passwd <remoteUser> as containerUser (no -u)
    const result = await this.host.dockerExec(containerId, ["getent", "passwd", remoteUser]);
    const exists = result.exitCode === 0 && result.stdout.trim().length > 0;
    if (!exists) {
      getLogger().warn(
        `[remote-user] remoteUser "${remoteUser}" does not exist in the container. ` +
          `Falling back to containerUser. Either add the user to the image ` +
          `(Dockerfile RUN useradd) or set containerUser to a user that exists.`,
      );
    }
    this.remoteUserChecked.set(containerId, { user: remoteUser, exists });
    return exists ? remoteUser : undefined;
  }

  async ensureInstalled(containerId: string, remoteUser?: string): Promise<ServerInfo> {
    // Resolve remoteUser early so the result is cached before extension
    // install. The resolved user is threaded through installServer so the
    // install dir is owned by remoteUser, matching how start runs.
    const resolvedUser = remoteUser
      ? await this.preflightRemoteUser(containerId, remoteUser)
      : undefined;
    getLogger().info(`[install] probing container...`);
    const { arch, commit, binaryPresent } =
      await this.probeContainer(containerId);
    getLogger().info(
      `[install] arch=${arch} commit=${commit} installed=${binaryPresent}`,
    );

    if (!binaryPresent) {
      await this.installServer(containerId, arch, resolvedUser);
    } else {
      getLogger().info(`[install] already installed, skipping download`);
    }

    const installRoot = await this.getServerInstallRoot(containerId);
    const installPath = this.getInstallPathWithRoot(installRoot, commit);

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
    user?: string,
  ): Promise<void> {
    if (!this.bootstrap) {
      throw new Error(
        "ServerManager has no bootstrap, extensionPath not provided",
      );
    }

    const url = await buildServerDownloadUrl(this.productInfo, arch);
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

    getLogger().debug(`[install] staging at ${stagingDir}`);
    // No `rm -rf stagingDir` here: the dir name includes a fresh UUID, so
    // it cannot pre-exist. setup.sh mkdir's it.

    getLogger().info(`[install] bootstrapping busybox...`);
    await this.bootstrap.bootstrapBusybox(containerId, arch, user);

    getLogger().info(`[install] deploying tools...`);
    await this.bootstrap.deployTools(containerId, user);

    const adapter = await getPlatformAdapter();
    const authFiles = adapter.readAuthFiles?.() ?? [];

    // Download server tarball client-side and verify checksum before
    // streaming it into the container.
    getLogger().info(`[install] downloading server from ${url}...`);
    const { downloadToBuffer } = await import("./download.js");
    const serverBuffer = await downloadToBuffer(url, (received, total) => {
      getLogger().debug(`[install] download progress: ${received}/${total ?? "?"} bytes`);
    });
    getLogger().info(`[install] downloaded ${serverBuffer.length} bytes`);

    // Verify checksum if enabled.
    if (this.productInfo.verifyChecksum) {
      const { fetchExpectedChecksum, verifyHash, computeHash } = await import("./checksum.js");
      const result = await fetchExpectedChecksum(
        url,
        this.productInfo,
        "linux",
        arch,
        getLogger(),
      );

      if ("expectedHash" in result) {
        const ok = verifyHash(serverBuffer, result.expectedHash, result.algo);
        if (!ok) {
          const actual = computeHash(serverBuffer, result.algo);
          throw new Error(
            `Server tarball checksum mismatch (${result.source}, ${result.algo}).\n` +
              `Expected: ${result.expectedHash}\n` +
              `Actual:   ${actual}\n` +
              `Aborting installation. Disable artizo.serverDownload.verifyChecksum to bypass.`,
          );
        }
        getLogger().info(`[install] checksum verified (${result.algo}, ${result.source})`);
      } else {
        // No checksum source available
        const policy = this.productInfo.onNoChecksum;
        if (policy === "abort") {
          throw new Error(
            `Server tarball checksum not available (${result.reason}) and ` +
              `artizo.serverDownload.onNoChecksum is set to "abort".`,
          );
        }
        if (policy === "warn") {
          getLogger().info(
            `[install] warning: no checksum available (${result.reason}), proceeding with HTTPS-only protection`,
          );
        }
        // "allow": proceed silently
      }
    } else {
      getLogger().info(`[install] checksum verification disabled by setting`);
    }

    getLogger().info(`[install] extracting server tarball...`);
    await this.bootstrap.runSetup(
      containerId,
      url,
      stagingDir,
      authFiles,
      serverBuffer,
      user,
    );


    // Read the actual REH commit from the extracted product.json, patch it
    // to match the IDE commit if they differ, and move staging to the
    // final bin/<commit>/ path - all in one docker exec to save two calls.
    // The install dir is named after the IDE commit (matching the official
    // extension), so only the tarball's product.json needs aligning. VS
    // Code's client/server commit check fails when they differ (always the
    // case for vscode-oss using VSCodium REH, and any cross-fork custom
    // download).
    //
    // Exit code is from the last command (mv); stderr from any failing
    // step propagates.
    if (!/^[0-9a-f]+$/.test(this.productInfo.commit)) {
      throw new Error(`Invalid commit id: ${this.productInfo.commit}`);
    }
    const productJsonPath = pathPosix.join(stagingDir, "product.json");
    const finalDir = this.getInstallPathWithRoot(
      installRoot,
      this.productInfo.commit,
    );
    getLogger().info(`[install] patching commit + finalizing...`);
    const finalizeCmd =
      `reh=$(sed -n 's/.*"commit": "\\([0-9a-f]*\\)".*/\\1/p' "${productJsonPath}"); ` +
      `if [ -n "$reh" ] && [ "$reh" != "${this.productInfo.commit}" ]; then ` +
      `sed -i 's/"commit": "[0-9a-f]*"/"commit": "${this.productInfo.commit}"/' "${productJsonPath}"; ` +
      `fi; ` +
      `rm -rf "${finalDir}" && ` +
      `mkdir -p "${pathPosix.dirname(finalDir)}" && ` +
      `mv "${stagingDir}" "${finalDir}"`;
    const finalizeResult = await this.host.dockerExec(
      containerId,
      ["sh", "-c", finalizeCmd],
      user ? { user } : undefined,
    );
    if (finalizeResult.exitCode !== 0) {
      throw new Error(
        `Commit patch + move failed (exit ${finalizeResult.exitCode}): ${finalizeResult.stderr || finalizeResult.stdout}`,
      );
    }

    // Use the IDE commit for the install dir, matching the official
    // extension convention and zygos.
    this.resolvedCommit = this.productInfo.commit;
    getLogger().info(`[install] done: ${finalDir}`);
  }

  /**
   * Create or read the connection token file atomically.
   *
   * Uses umask 377 for restrictive permissions (0400) and mv -n for
   * race-condition safety.
   */
  async ensureConnectionToken(
    containerId: string,
    remoteUser?: string,
  ): Promise<string> {
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

    const result = await this.host.dockerExec(
      containerId,
      tokenCmd,
      remoteUser ? { user: remoteUser } : undefined,
    );

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
  async start(containerId: string, remoteUser?: string): Promise<ServerInfo> {
    const arch = await this.detectArch(containerId);
    const installRoot = await this.getServerInstallRoot(containerId);
    const commit = await this.resolveServerCommit(containerId);
    const resolvedUser = await this.preflightRemoteUser(containerId, remoteUser);
    const connectionToken = await this.ensureConnectionToken(
      containerId,
      resolvedUser,
    );
    const installPath = this.getInstallPathWithRoot(installRoot, commit);
    const tokenFilePath = this.getTokenFilePath(installRoot, commit);
    const serverDataDir = this.getServerDataDir(installRoot);
    const binaryName = this.productInfo.serverApplicationName;
    const logFile = pathPosix.join(installPath, "server.log");
    const pidFile = pathPosix.join(installPath, "server.pid");

    const log = getLogger();
    const probe = await this.probeRunningServer(containerId, pidFile, logFile);
    log.info(
      `[server] probe ${containerId.slice(0, 12)}: ${probe.status}` +
        (probe.port ? ` port=${probe.port}` : "") +
        (probe.pid ? ` pid=${probe.pid}` : ""),
    );

    if (probe.status === "reuse" && probe.port) {
      log.info(
        `[server] reusing running server in ${containerId.slice(0, 12)} on port ${probe.port} (no stop/start)`,
      );
      return { commit, arch, installPath, port: probe.port, connectionToken };
    }

    log.info(
      `[server] not reusing (${probe.status}); stopping and starting fresh in ${containerId.slice(0, 12)}`,
    );
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

    const startResult = await this.host.dockerExec(containerId, startCmd, resolvedUser ? { user: resolvedUser } : undefined);

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

  /**
   * Probe for a running server on the current install path.
   *
   * Single docker exec sh script:
   * - no pidFile            -> "none"
   * - pid dead              -> "dead" (stale pidFile removed)
   * - pid alive, no port in log -> "noport" (stale pidFile removed)
   * - pid alive, port found, /version responds -> "reuse"
   * - pid alive, port found, /version fails    -> "unresponsive"
   *
   * The port is parsed from server.log (the server announces it there;
   * there is no dedicated port file). The /version check uses wget or curl,
   * whichever the image has; if neither exists we fall back to trusting the
   * live pid + announced port ("reuse"), since a hung server is rare and
   * the connection attempt will fail fast anyway.
   */
  private async probeRunningServer(
    containerId: string,
    pidFile: string,
    logFile: string,
  ): Promise<ProbeResult> {
    const script =
      `pid=$(cat "${pidFile}" 2>/dev/null); ` +
      `if [ -z "$pid" ]; then echo NONE; exit 0; fi; ` +
      `if ! kill -0 "$pid" 2>/dev/null; then rm -f "${pidFile}"; echo "DEAD:$pid"; exit 0; fi; ` +
      `port=$(grep -oE 'Extension host agent listening on [0-9]+|listeningOn: *[0-9]+|listening on port [0-9]+' "${logFile}" 2>/dev/null | grep -oE '[0-9]+' | tail -1); ` +
      `if [ -z "$port" ]; then rm -f "${pidFile}"; echo "NOPORT:$pid"; exit 0; fi; ` +
      `if command -v curl >/dev/null 2>&1; then ` +
      `  if curl -s -f -o /dev/null --max-time 3 "http://127.0.0.1:$port/version"; then echo "REUSE:$pid:$port"; else echo "UNRESPONSIVE:$pid:$port"; fi; ` +
      `elif command -v wget >/dev/null 2>&1; then ` +
      `  if wget -q -T 3 -O /dev/null "http://127.0.0.1:$port/version"; then echo "REUSE:$pid:$port"; else echo "UNRESPONSIVE:$pid:$port"; fi; ` +
      `else echo "REUSE:$pid:$port"; fi`;

    let out: string;
    try {
      const result = await this.host.dockerExec(containerId, [
        "sh",
        "-c",
        script,
      ]);
      if (result.exitCode !== 0) {
        getLogger().warn(
          `[server] probe exec failed (exit ${result.exitCode}): ${result.stderr}`,
        );
        return { status: "none" };
      }
      out = result.stdout;
    } catch (err) {
      getLogger().warn(
        `[server] probe error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: "none" };
    }

    return parseProbeOutput(out);
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
