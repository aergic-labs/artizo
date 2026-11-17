/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Config-file reads/writes that follow the active remote ExecServer.
 *
 * In a UI-only extension in an SSH window, `URI.file(...)` and `node:fs` refer
 * to the apex, not the SSH host. Config paths (devcontainer.json, Dockerfile,
 * compose, override) live on the SSH host, so they must be read/written via
 * the ExecServer when one is active. Local windows keep using `node:fs`.
 */

import { getActiveExecServer } from "../remote/execServerCache";
import type { RemoteFs } from "../remote/execServerBridge";

/** Reader for a config file (absolute, target-side path). */
export type ReadFileFn = (path: string) => Promise<Buffer>;

/** Read a config file from the remote when an ExecServer is active, else local. */
export async function readConfigFileBuffer(path: string): Promise<Buffer> {
  const execServer = getActiveExecServer();
  if (execServer?.fs) {
    return readAll(execServer.fs, path);
  }
  const fs = await import("node:fs/promises");
  return fs.readFile(path);
}

/** UTF-8 text read for config files. */
export async function readConfigFileText(path: string): Promise<string> {
  return (await readConfigFileBuffer(path)).toString("utf-8");
}

/**
 * Write a temporary config file (e.g. the override devcontainer.json) and
 * return its target-side path. Remote path is `/tmp/<name>` so `RemoteCliHost`
 * can read it.
 */
export async function writeTempConfigFile(
  name: string,
  content: string,
): Promise<string> {
  const execServer = getActiveExecServer();
  if (execServer?.fs) {
    const remotePath = `/tmp/${name}`;
    const { stream, done } = await execServer.fs.write(remotePath);
    stream.write(new Uint8Array(Buffer.from(content, "utf-8")));
    stream.end();
    await done;
    return remotePath;
  }
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const localPath = path.join(os.tmpdir(), name);
  await fs.writeFile(localPath, content, "utf-8");
  return localPath;
}

/** Remove a temporary config file on the target side. Best-effort. */
export async function removeTempConfigFile(path: string): Promise<void> {
  const execServer = getActiveExecServer();
  if (execServer?.fs) {
    try {
      await execServer.fs.rm(path);
    } catch {
      /* missing */
    }
    return;
  }
  const fs = await import("node:fs/promises");
  try {
    await fs.unlink(path);
  } catch {
    /* best effort */
  }
}

async function readAll(remoteFs: RemoteFs, path: string): Promise<Buffer> {
  const stream = await remoteFs.read(path);
  const chunks: Uint8Array[] = [];
  stream.onDidReceiveMessage((d) => chunks.push(d));
  await stream.onEnd;
  return Buffer.concat(chunks);
}