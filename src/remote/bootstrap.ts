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
import { dockerSpawn as realDockerSpawn } from "../utils/dockerUtils";

// Constants
const ARTIZO_BIN = "/tmp/.artizo/bin";
const BLOCK = 512;
/** Inactivity timeout for the server download (ms). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Max HTTP redirects to follow when downloading the server. */
const MAX_DOWNLOAD_REDIRECTS = 5;

// Minimal tar creator (zero deps)
function createTar(
  entries: Array<{
    name: string;
    hostPath: string;
    mode: number; // octal, e.g. 0o755
  }>,
): Buffer {
  const chunks: Buffer[] = [];

  for (const { name, hostPath, mode } of entries) {
    const content = readFileSync(hostPath);
    const header = Buffer.alloc(BLOCK, 0);
    header.write(name.slice(0, 100), 0, 100, "utf-8"); // name
    header.write(oct(mode, 7), 100, 8, "utf-8"); // mode
    header.write(oct(0, 7), 108, 8, "utf-8"); // uid
    header.write(oct(0, 7), 116, 8, "utf-8"); // gid
    const size = content.length;
    header.write(oct(size, 11), 124, 12, "utf-8"); // size
    header.write(oct(Math.floor(Date.now() / 1000), 11), 136, 12, "utf-8"); // mtime
    header.write("0", 156, 1, "utf-8"); // typeflag: regular file
    header.write("ustar\0", 257, 6, "utf-8"); // magic
    header.write(oct(checksum(header), 6), 148, 7, "utf-8"); // checksum

    chunks.push(header);
    chunks.push(content);

    // Pad to 512-byte boundary
    const rem = size % BLOCK;
    if (rem > 0) chunks.push(Buffer.alloc(BLOCK - rem, 0));
  }

  // Two zero blocks = end of archive
  chunks.push(Buffer.alloc(BLOCK * 2, 0));

  return Buffer.concat(chunks);
}

function oct(num: number, len: number): string {
  const s = num.toString(8);
  return "0".repeat(Math.max(0, len - s.length)) + s + "\0";
}

function checksum(header: Buffer): number {
  // Checksum field (bytes 148-155) is treated as spaces during calculation
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  return sum;
}

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

  async bootstrapBusybox(containerId: string, arch: string): Promise<void> {
    const busyboxPath = join(
      this.extensionPath,
      "tools",
      "busybox",
      `bb-${arch}`,
    );
    const busyboxBuf = readFileSync(busyboxPath);

    const child = this.spawner(this.dockerPath, [
      "exec",
      "-i",
      containerId,
      "sh",
      "-c",
      "mkdir -p /tmp/.artizo/bin && " +
        "cat > /tmp/.artizo/bin/busybox && " +
        "chmod +x /tmp/.artizo/bin/busybox && " +
        "/tmp/.artizo/bin/busybox --install -s /tmp/.artizo/bin",
    ]);

    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));

    child.stdin!.write(busyboxBuf);
    child.stdin!.end();

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    if (exitCode !== 0) {
      throw new Error(
        `Failed to bootstrap busybox (exit ${exitCode}): ${stderr}`,
      );
    }
  }

  async deployTools(containerId: string): Promise<void> {
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

    const child = this.spawner(this.dockerPath, [
      "exec",
      "-i",
      containerId,
      "/tmp/.artizo/bin/tar",
      "-xC",
      ARTIZO_BIN,
    ]);

    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));

    child.stdin!.write(tarBuf);
    child.stdin!.end();

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
    authToken?: string,
    authTokenPath?: string,
  ): Promise<BootstrapResult> {
    const args = ["exec", "-i", "-e", `ARTIZO_SERVER_ROOT=${installPath}`];
    const sendToken = Boolean(authToken && authTokenPath);
    if (sendToken) {
      // The SSO token is streamed on stdin (base64, first line) rather than
      // passed as `-e ARTIZO_AUTH_TOKEN=...`, so it never lands on the host
      // `docker` process argv (visible via `ps` / `/proc/<pid>/cmdline`).
      // Only the non-sensitive destination path and a marker flag go on argv.
      args.push("-e", "ARTIZO_AUTH_TOKEN_STDIN=1");
      args.push("-e", `ARTIZO_AUTH_TOKEN_PATH=${authTokenPath}`);
    }
    args.push(containerId, "/tmp/.artizo/bin/sh", "/tmp/.artizo/bin/setup.sh");

    // Spawn first so setup.sh is ready to read from stdin
    const child = this.spawner(this.dockerPath, args);

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));

    const exitCodePromise = new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    // Download server tarball into memory
    getLogger().info(`[Artizo] downloading server...`);
    const serverBuf = await this.downloadServer(serverUrl);

    getLogger().info(`[Artizo] running setup...`);
    // Auth token goes first as a single base64 line; setup.sh consumes it with
    // one `read` before piping the remaining stdin (the tarball) into gzip.
    if (sendToken) {
      const tokenB64 = Buffer.from(authToken!).toString("base64");
      child.stdin!.write(Buffer.from(`${tokenB64}\n`));
    }
    child.stdin!.write(serverBuf);
    child.stdin!.end();

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