/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Container-config drift check executed on the SSH host from the Windows
 * resolver, through the zygos ExecServer (already-authenticated SSH
 * connection - no new SSH process, no askpass).
 *
 * Used when a container window on an SSH host resolves: the resolver has
 * no local Docker, but the ExecServer can run `docker inspect` and read
 * config files on the host where the container lives.
 *
 * Every step logs to the resolver diag log so the check's behavior is
 * observable without shell access.
 *
 * Known gap: only the devcontainer.json itself is hashed on this path.
 * Referenced files (Dockerfile, compose) live on the SSH host and this
 * check runs on Windows; the provision-time check (runs on the host with
 * real fs) covers those. A config edit that only touches a referenced
 * file is not detected on reconnect here.
 */

import type { ExecServer } from "./execServerBridge";
import {
  hashDevcontainerJsonOnly,
  compareConfigHashes,
  deserializeConfigHashes,
} from "../config/configHash";

const LABEL_CONFIG_FILE = "artizo.config_file";
const LABEL_CONFIG_HASH = "artizo.config_hash";

export type RemoteCheckOutcome =
  | { kind: "match" }
  | { kind: "changed"; files: string[] }
  | { kind: "no-label" }
  | { kind: "skip"; reason: string };

type LogFn = (msg: string) => void;

/** Find a container on the SSH host by its workspace-folder label. */
export async function remoteFindContainer(
  execServer: ExecServer,
  hostWorkspacePath: string,
  log: LogFn,
): Promise<string | undefined> {
  const ids = new Set<string>();
  for (const label of ["artizo.local_folder", "devcontainer.local_folder"]) {
    const result = await remoteExec(
      execServer,
      "docker",
      ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${label}=${hostWorkspacePath}`],
      log,
    );
    if (result.status !== 0) continue;
    for (const id of result.stdout.trim().split("\n").filter(Boolean)) {
      ids.add(id);
    }
  }
  return ids.values().next().value;
}

/** Run a command on the SSH host via ExecServer spawn; capture stdout. */
async function remoteExec(
  execServer: ExecServer,
  command: string,
  args: string[],
  log: LogFn,
): Promise<{ stdout: string; status: number }> {
  if (typeof execServer.spawn !== "function") {
    throw new Error("ExecServer has no spawn");
  }
  const spawned = (await execServer.spawn(command, args)) as {
    stdout: { onDidReceiveMessage(cb: (d: Uint8Array) => void): void };
    stderr: { onDidReceiveMessage(cb: (d: Uint8Array) => void): void };
    onExit: Promise<{ status: number; message?: string }>;
  };
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  spawned.stdout.onDidReceiveMessage((d) => outChunks.push(d));
  spawned.stderr.onDidReceiveMessage((d) => errChunks.push(d));
  const exit = await spawned.onExit;
  const stdout = Buffer.concat(outChunks).toString("utf-8");
  const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
  log(
    `[remote-check] exec ${command} ${args.join(" ")} -> status=${exit.status} stdout=${stdout.length}b stderr=${stderr.slice(0, 200)}`,
  );
  return { stdout, status: exit.status };
}

/**
 * Run the config drift check for a container living on an SSH host.
 *
 * @param execServer authenticated ExecServer for the SSH host (zygos)
 * @param containerId full container ID on the SSH host
 * @param log diag logger (resolver log file)
 */
export async function checkContainerConfigRemote(
  execServer: ExecServer,
  containerId: string,
  log: LogFn,
): Promise<RemoteCheckOutcome> {
  // 1. Labels.
  const inspect = await remoteExec(
    execServer,
    "docker",
    ["inspect", containerId, "--format", "{{json .Config.Labels}}"],
    log,
  );
  if (inspect.status !== 0) {
    return { kind: "skip", reason: `docker inspect failed (${inspect.status})` };
  }
  let labels: Record<string, string>;
  try {
    labels = JSON.parse(inspect.stdout.trim() || "{}") as Record<string, string>;
  } catch {
    return { kind: "skip", reason: "unparseable inspect labels" };
  }

  const configPath = labels[LABEL_CONFIG_FILE];
  if (!configPath) {
    log(`[remote-check] no ${LABEL_CONFIG_FILE} label, foreign container`);
    return { kind: "skip", reason: "no config_file label" };
  }

  const stored = deserializeConfigHashes(labels[LABEL_CONFIG_HASH]);
  if (!stored) {
    log(`[remote-check] no ${LABEL_CONFIG_HASH} label (predates tracking)`);
    return { kind: "no-label" };
  }

  // 2. Current config on the SSH host.
  const cat = await remoteExec(execServer, "cat", [configPath], log);
  if (cat.status !== 0) {
    return { kind: "skip", reason: `cannot read ${configPath}` };
  }
  let config: Record<string, unknown>;
  try {
    const { parse } = await import("jsonc-parser");
    config = parse(cat.stdout) as Record<string, unknown>;
  } catch (err) {
    return {
      kind: "skip",
      reason: `config parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Hash (devcontainer.json only - see header) + compare. Stored labels
  // may contain referenced-file entries we cannot check remotely; restrict
  // the comparison to the config-file key so those don't false-positive.
  log(`[remote-check] hashing devcontainer.json only (referenced files unchecked on this path)`);
  const current = hashDevcontainerJsonOnly(config, configPath);
  const storedConfigOnly: typeof stored = {};
  for (const key of Object.keys(current)) {
    if (key in stored) storedConfigOnly[key] = stored[key];
  }
  const diff = compareConfigHashes(storedConfigOnly, current);
  if (!diff.changed) {
    log(`[remote-check] hashes match (${Object.keys(current).length} file(s))`);
    return { kind: "match" };
  }
  const files = [...diff.modified, ...diff.added, ...diff.deleted];
  log(`[remote-check] config changed: ${files.join(", ")}`);
  return { kind: "changed", files };
}
