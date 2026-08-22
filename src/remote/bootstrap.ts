/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Container bootstrap via static busybox.
 *
 * Only requires /bin/sh in the container.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { get as httpsGet } from "node:https";
import { getLogger } from "../utils/logger";
import {
  dockerSpawn as realDockerSpawn,
  childPipes,
} from "../utils/dockerUtils";
import { createTar } from "../utils/tar";

// Constants
const ARTIZO_BIN = "/tmp/.artizo/bin";
/** Inactivity timeout for the server download (ms). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Max HTTP redirects to follow when downloading the server. */
const MAX_DOWNLOAD_REDIRECTS = 5;

// Public API
/** Parse HOME=... line from setup script stdout. */
export function parseHome(stdout: string): string {
  const m = stdout.match(/^HOME=(.*)$/m);
  return m ? m[1].trim() : "/root";
}

export interface BootstrapOptions {
  dockerPath?: string;
  extensionPath: string;
  /** Override for testing. Defaults to dockerSpawn from dockerUtils. */
  spawner?: typeof realDockerSpawn;
  /** Override for testing. Defaults to node:https get. */
  fetcher?: typeof httpsGet;
}

export interface BootstrapResult {
  home: string;
}

export class ContainerBootstrap {
  private readonly dockerPath: string;
  private readonly extensionPath: string;
  private readonly spawner: typeof realDockerSpawn;
  private readonly fetcher: typeof httpsGet;

  constructor(options: BootstrapOptions) {
    this.dockerPath = options.dockerPath ?? "docker";
    this.extensionPath = options.extensionPath;
    this.spawner = options.spawner ?? realDockerSpawn;
    this.fetcher = options.fetcher ?? httpsGet;
  }

  async bootstrapBusybox(
    containerId: string,
    arch: string,
    user?: string,
  ): Promise<void> {
    const busyboxPath = join(
      this.extensionPath,
      "tools",
      "busybox",
      `bb-${arch}`,
    );
    const busyboxBuf = readFileSync(busyboxPath);

    const args = ["exec", "-i"];
    if (user) args.push("-u", user);
    args.push(
      containerId,
      "sh",
      "-c",
      "mkdir -p /tmp/.artizo/bin && " +
        "cat > /tmp/.artizo/bin/busybox && " +
        "chmod +x /tmp/.artizo/bin/busybox && " +
        "/tmp/.artizo/bin/busybox --install -s /tmp/.artizo/bin",
    );
    const child = this.spawner(this.dockerPath, args);

    const pipes = childPipes(child);
    let stderr = "";
    pipes.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    pipes.stdin.write(busyboxBuf);
    pipes.stdin.end();

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    if (exitCode !== 0) {
      throw new Error(
        `Failed to bootstrap busybox (exit ${exitCode}): ${stderr}`,
      );
    }
  }

  async deployTools(containerId: string, user?: string): Promise<void> {
    const toolsDir = join(this.extensionPath, "tools");
    const tarBuf = createTar([
      {
        name: "relay.js",
        hostPath: join(toolsDir, "relay.js"),
        mode: 0o644,
      },
      {
        name: "setup.sh",
        hostPath: join(toolsDir, "setup.sh"),
        mode: 0o755,
      },
    ]);

    const args = ["exec", "-i"];
    if (user) args.push("-u", user);
    args.push(containerId, "/tmp/.artizo/bin/tar", "-xC", ARTIZO_BIN);
    const child = this.spawner(this.dockerPath, args);

    const pipes = childPipes(child);
    let stderr = "";
    pipes.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    pipes.stdin.write(tarBuf);
    pipes.stdin.end();

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    if (exitCode !== 0) {
      throw new Error(`Failed to deploy tools (exit ${exitCode}): ${stderr}`);
    }
  }

  async runSetup(
    containerId: string,
    serverUrl: string,
    installPath: string,
    authFiles: Array<{ path: string; content: string }> = [],
    serverBuffer?: Buffer,
    user?: string,
  ): Promise<BootstrapResult> {
    const args = ["exec", "-i"];
    if (user) args.push("-u", user);
    args.push("-e", `ARTIZO_SERVER_ROOT=${installPath}`);
    if (authFiles.length > 0) {
      // Auth files are streamed on stdin (path\nbase64\n pairs followed
      // by a blank line, then the server tarball) rather than passed as
      // `-e` env vars, so file contents never land on the host `docker`
      // process argv (visible via `ps` / `/proc/<pid>/cmdline`).
      args.push("-e", "ARTIZO_AUTH_FILES_STDIN=1");
    }
    args.push(containerId, "/tmp/.artizo/bin/sh", "/tmp/.artizo/bin/setup.sh");

    // Spawn first so setup.sh is ready to read from stdin
    const child = this.spawner(this.dockerPath, args);

    const pipes = childPipes(child);
    let stdout = "";
    let stderr = "";
    pipes.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    pipes.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    const exitCodePromise = new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    // Use pre-downloaded buffer if provided, otherwise download here.
    getLogger().debug(`[install] ${serverBuffer ? "using pre-downloaded" : "downloading"} server...`);
    const serverBuf = serverBuffer ?? await this.downloadServer(serverUrl);

    getLogger().debug(`[install] streaming tarball to setup.sh...`);
    // Auth files go first: for each, a relative-path line followed by a
    // base64-content line. A blank line terminates the auth section so
    // setup.sh knows to pipe the remaining stdin (the tarball) into gzip.
    for (const f of authFiles) {
      pipes.stdin.write(Buffer.from(`${f.path}\n`));
      pipes.stdin.write(
        Buffer.from(`${Buffer.from(f.content, "utf-8").toString("base64")}\n`),
      );
    }
    if (authFiles.length > 0) {
      pipes.stdin.write(Buffer.from("\n"));
    }
    pipes.stdin.write(serverBuf);
    pipes.stdin.end();

    const exitCode = await exitCodePromise;

    if (exitCode !== 0) {
      throw new Error(`Setup script failed (exit ${exitCode}): ${stderr}`);
    }

    return { home: parseHome(stdout) };
  }

  /**
   * Download the server tarball into a Buffer, following up to
   * MAX_DOWNLOAD_REDIRECTS redirects. Rejects on HTTP error, redirect loop,
   * or an inactivity timeout so a stalled download fails fast instead of
   * hanging the provision forever.
   */
  private downloadServer(serverUrl: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const attempt = (url: string, redirectsLeft: number): void => {
        const req = this.fetcher(url, (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers?.location;

          if (status >= 300 && status < 400 && location) {
            res.resume?.(); // drain so the socket can close
            if (redirectsLeft <= 0) {
              fail(new Error("Too many redirects fetching server"));
              return;
            }
            attempt(location, redirectsLeft - 1);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume?.();
            fail(new Error(`HTTP ${res.statusCode} fetching server`));
            return;
          }

          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
          });
          res.on("error", fail);
        });

        req.on("error", fail);
        // Inactivity timeout: fires if the connection stalls with no data.
        req.setTimeout?.(DOWNLOAD_TIMEOUT_MS, () => {
          req.destroy?.(
            new Error(
              `server download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`,
            ),
          );
        });
      };

      attempt(serverUrl, MAX_DOWNLOAD_REDIRECTS);
    });
  }
}