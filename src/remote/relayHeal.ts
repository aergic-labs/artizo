/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Apex-side relay heal for devcontainer-over-SSH.
 *
 * When a container window is reloaded after the relay daemon on the SSH host
 * has died (30-min idle timeout, ssh-host reboot, crash), nothing listens on
 * the relay's port and the resolver's probe fails.
 *
 * This module re-spawns the relay through the ExecServer. The relay writes
 * `{nodePath, installPath, dockerPath, port, daemonHash, logFile, containerId,
 * containerPort}` to its meta file at startup, keyed by the workspace's stable
 * identity, so the apex can re-spawn it without those fields being in the
 * authority.
 */

import * as path from "node:path";
import type { ExecServer } from "./execServerBridge";
import {
  stableMetaPath,
  stablePidPath,
  readRelayMeta,
  IDLE_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  type StableWorkspaceIdentity,
} from "./containerProxy";

export type HealResult =
  | { kind: "ok" }
  | { kind: "container-missing"; message: string }
  | { kind: "no-heal-info" }
  | { kind: "error"; message: string };

export interface HealParams {
  /** Stable workspace identity; keys the meta and pid paths. */
  identity: StableWorkspaceIdentity;
  /** Max wait for the relay to report a port. Default 10s. */
  metaFileTimeoutMs?: number;
}

type LogFn = (msg: string) => void;

const REMOTE_TMP = "/tmp";

/** Where the extension copies the relay daemon on the SSH host. */
const REMOTE_SCRIPT_PATH = `${REMOTE_TMP}/artizo-relay.cjs`;

/** Run a command on the SSH host via ExecServer spawn; capture stdout. */
async function remoteExec(
  execServer: ExecServer,
  command: string,
  args: string[],
  log: LogFn,
): Promise<{ stdout: string; status: number; stderr: string }> {
  if (typeof execServer.spawn !== "function") {
    throw new Error("ExecServer has no spawn");
  }
  const spawned = await execServer.spawn(command, args);
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  spawned.stdout.onDidReceiveMessage((d) => outChunks.push(d));
  spawned.stderr.onDidReceiveMessage((d) => errChunks.push(d));
  const exit = await spawned.onExit;
  const stdout = Buffer.concat(outChunks).toString("utf-8");
  const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
  log(
    `[relay-heal] exec ${command} ${args.join(" ")} -> status=${exit.status} stdout=${stdout.length}b stderr=${stderr.slice(0, 200)}`,
  );
  return { stdout, status: exit.status, stderr };
}

/**
 * Quick liveness probe for the relay port via the ExecServer's tcpConnect.
 * Returns false when nothing is listening.
 */
export async function probeRelaySocket(
  execServer: ExecServer,
  port: number,
  log: LogFn,
  timeoutMs = 2_000,
): Promise<boolean> {
  const timer = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), timeoutMs),
  );
  try {
    const result = await Promise.race([
      execServer.tcpConnect("127.0.0.1", port).then(({ stream, done }) => {
        try {
          stream.end();
        } catch {
          /* best effort */
        }
        void done.catch(() => {
          /* expected on refused */
        });
        return true;
      }),
      timer,
    ]);
    log(
      `[relay-heal] probe 127.0.0.1:${port} -> ${result ? "alive" : "no-response"}`,
    );
    return result;
  } catch (err: unknown) {
    log(
      `[relay-heal] probe 127.0.0.1:${port} threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Re-spawn the relay daemon on the SSH host from the heal info in its meta
 * file. Returns a typed result; the caller probes before and bridges after.
 */
export async function healRelay(
  execServer: ExecServer,
  params: HealParams,
  log: LogFn,
): Promise<HealResult> {
  const { identity, metaFileTimeoutMs = 10_000 } = params;
  const metaFile = stableMetaPath(identity);
  const pidFile = stablePidPath(identity);

  if (typeof execServer.spawn !== "function" || !execServer.fs) {
    return {
      kind: "error",
      message: "ExecServer has no spawn/fs; cannot heal relay",
    };
  }

  // 1. Read the heal info the relay wrote at startup.
  const relayMeta = await readRelayMeta(execServer, metaFile);
  if (!relayMeta) {
    return { kind: "no-heal-info" };
  }
  if (
    typeof relayMeta.hostNodePath !== "string" ||
    !relayMeta.hostNodePath.trim() ||
    typeof relayMeta.nodePath !== "string" ||
    !relayMeta.nodePath.trim() ||
    typeof relayMeta.containerId !== "string" ||
    !relayMeta.containerId.trim() ||
    typeof relayMeta.containerPort !== "number" ||
    relayMeta.containerPort <= 0
  ) {
    return {
      kind: "error",
      message: `Relay meta file at ${metaFile} is incomplete; cannot re-spawn. Rebuild the container.`,
    };
  }
  log(`[relay-heal] using host node from meta: ${relayMeta.hostNodePath}`);

  const friendly = friendlyName(
    identity.hostWorkspacePath,
    relayMeta.containerId,
  );

  // 2. Verify the container is still present and running.
  const inspect = await remoteExec(
    execServer,
    "docker",
    ["inspect", relayMeta.containerId, "--format", "{{.State.Running}}"],
    log,
  );
  if (inspect.status !== 0 || inspect.stdout.trim() !== "true") {
    return {
      kind: "container-missing",
      message: `Container for ${friendly} has been removed or stopped; rebuild required.`,
    };
  }

  // 3. Re-spawn the daemon the extension already copied to the host.
  const config = {
    containerId: relayMeta.containerId,
    containerPort: relayMeta.containerPort,
    nodePath: relayMeta.nodePath,
    dockerPath: relayMeta.dockerPath ?? "docker",
    port: 0,
    pidFile,
    metaFile,
    hostNodePath: relayMeta.hostNodePath,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    maxFailures: MAX_CONSECUTIVE_FAILURES,
    logFile: relayMeta.logFile ?? `${REMOTE_TMP}/artizo-relay.log`,
    spawnedBy: "heal",
    daemonHash: relayMeta.daemonHash ?? "",
  };

  // Delete the pid file first so its reappearance is the readiness signal.
  try {
    await execServer.fs.rm(pidFile);
  } catch {
    /* missing */
  }

  const spawned = await execServer.spawn(relayMeta.hostNodePath, [
    REMOTE_SCRIPT_PATH,
    JSON.stringify(config),
  ]);
  spawned.stdout.onDidReceiveMessage(() => {});
  spawned.stderr.onDidReceiveMessage(() => {});
  void spawned.onExit.catch(() => {});

  // 4. Wait for the relay to write its pid file (it does so once listening).
  const ok = await waitForPidFile(execServer, pidFile, metaFileTimeoutMs);
  if (!ok) {
    return {
      kind: "error",
      message: `Relay did not start within ${metaFileTimeoutMs}ms`,
    };
  }
  log(`[relay-heal] relay respawned`);
  return { kind: "ok" };
}

async function waitForPidFile(
  execServer: ExecServer,
  pidFile: string,
  timeoutMs: number,
): Promise<boolean> {
  const remoteFs = execServer.fs;
  if (!remoteFs) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await remoteFs.stat(pidFile);
      return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function friendlyName(hostWorkspacePath: string, containerId: string): string {
  const trimmed = (hostWorkspacePath ?? "").trim();
  if (trimmed) {
    const base = path.posix.basename(trimmed);
    if (base) return base;
    return trimmed;
  }
  return containerId.slice(0, 12);
}
