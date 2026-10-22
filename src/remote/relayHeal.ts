/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Apex-side relay heal for State 4 (devcontainer over SSH).
 *
 * When a container window is reloaded after the relay daemon on the SSH host
 * has died (30-min idle timeout, ssh-host reboot, crash), the cached
 * `relayPort` in the authority payload points at nothing. The resolver gets
 * `Connection refused` and times out.
 *
 * This module re-spawns the relay through the zygos ExecServer, then returns
 * the new port so the resolver can bridge to it. Gated on the ExecServer
 * path (zygos experimental transport); the default `ssh -L` fallback is
 * unchanged.
 */

import * as path from "node:path";
import type { ExecServer } from "./execServerBridge";
import {
  buildRelayScript,
  IDLE_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
} from "./containerProxy";

export type HealResult =
  | { kind: "ok"; relayPort: number }
  | { kind: "container-missing"; message: string }
  | { kind: "no-heal-info" }
  | { kind: "error"; message: string };

export interface HealParams {
  /** SSH host container ID (from the authority payload). */
  containerId: string;
  /** Port server-main.js listens on inside the container. */
  containerPort: number;
  /** Server install path inside the container; `<installPath>/node` is exec'd. */
  installPath: string;
  /** Friendly workspace path for error messages (e.g. /home/ubuntu/foo). */
  hostWorkspacePath: string;
  /** Max wait for the relay to write its port file. Default 10s. */
  portFileTimeoutMs?: number;
}

type LogFn = (msg: string) => void;

const REMOTE_TMP = "/tmp";

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
    `[relay-heal] exec ${command} ${args.join(" ")} -> status=${exit.status} stdout=${stdout.length}b stderr=${stderr.slice(0, 200)}`,
  );
  return { stdout, status: exit.status, stderr };
}

/**
 * Quick liveness probe for the cached relay port via the ExecServer's
 * tcpConnect. Returns true if the port accepted a connection.
 */
export async function probeRelayPort(
  execServer: ExecServer,
  port: number,
  log: LogFn,
  timeoutMs = 2_000,
): Promise<boolean> {
  const timer = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), timeoutMs),
  );
  try {
    const connect = Promise.race([
      execServer.tcpConnect("127.0.0.1", port).then(({ stream, done }) => {
        try { stream.end(); } catch { /* best effort */ }
        void done.catch(() => { /* expected on refused */ });
        return true;
      }),
      timer,
    ]);
    const result = await connect;
    log(`[relay-heal] probe 127.0.0.1:${port} -> ${result ? "alive" : "no-response"}`);
    return result;
  } catch (err: unknown) {
    log(
      `[relay-heal] probe 127.0.0.1:${port} threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Re-spawn the relay daemon on the SSH host. Returns the new port on success
 * or a typed error. Does NOT touch `execServer.tcpConnect`; the caller
 * probes first and bridges after.
 */
export async function healRelay(
  execServer: ExecServer,
  params: HealParams,
  log: LogFn,
): Promise<HealResult> {
  const {
    containerId,
    containerPort,
    installPath,
    hostWorkspacePath,
    portFileTimeoutMs = 10_000,
  } = params;

  const friendly = friendlyName(hostWorkspacePath, containerId);

  if (typeof execServer.spawn !== "function") {
    return { kind: "error", message: "ExecServer has no spawn; cannot heal relay" };
  }

  // 1. Verify the container is still present and running.
  const inspect = await remoteExec(
    execServer,
    "docker",
    ["inspect", containerId, "--format", "{{.State.Running}}"],
    log,
  );
  if (inspect.status !== 0 || inspect.stdout.trim() !== "true") {
    return {
      kind: "container-missing",
      message: `Container for ${friendly} has been removed or stopped; rebuild required.`,
    };
  }

  // 2. Build the relay script content (same generator the workspace side uses).
  const scriptPath = `${REMOTE_TMP}/artizo-relay.mjs`;
  const pidFile = `${REMOTE_TMP}/artizo-relay-${containerId}.pid`;
  const portFile = `${REMOTE_TMP}/artizo-relay-${containerId}.port`;
  const script = buildRelayScript({
    containerId,
    containerPort,
    nodePath: `${installPath}/node`,
    dockerPath: "docker",
    pidFile,
    portFile,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    maxFailures: MAX_CONSECUTIVE_FAILURES,
  });

  // 3. Ship the script to the SSH host via stdin.
  if (typeof execServer.spawn !== "function") {
    return { kind: "error", message: "ExecServer has no spawn; cannot ship relay script" };
  }
  const writeProc = (await execServer.spawn("sh", [
    "-c",
    `cat > ${shQuote(scriptPath)} && chmod +x ${shQuote(scriptPath)}`,
  ])) as {
    stdin: { write(data: Uint8Array): void; end(): void };
    stderr: { onDidReceiveMessage(cb: (d: Uint8Array) => void): void };
    onExit: Promise<{ status: number; message?: string }>;
  };
  const writeErr: Uint8Array[] = [];
  writeProc.stderr.onDidReceiveMessage((d) => writeErr.push(d));
  const scriptBytes = Buffer.from(script, "utf-8");
  writeProc.stdin.write(new Uint8Array(scriptBytes.buffer, scriptBytes.byteOffset, scriptBytes.byteLength));
  writeProc.stdin.end();
  const writeExit = await writeProc.onExit;
  if (writeExit.status !== 0) {
    const stderr = Buffer.concat(writeErr).toString("utf-8").trim();
    log(`[relay-heal] script write failed: status=${writeExit.status} stderr=${stderr.slice(0, 200)}`);
    return {
      kind: "error",
      message: `Failed to ship relay script to SSH host: ${stderr || `exit ${writeExit.status}`}`,
    };
  }
  log(`[relay-heal] relay script shipped (${scriptBytes.length}b)`);

  // 4. Clean stale pid/port files, spawn the daemon detached, poll for the
  //    port file. One shell invocation handles all three so we keep this to a
  //    single round-trip.
  const pollTicks = Math.max(10, Math.floor(portFileTimeoutMs / 100));
  const spawnCmd = [
    `rm -f ${shQuote(pidFile)} ${shQuote(portFile)}`,
    `nohup node ${shQuote(scriptPath)} >${shQuote(`${REMOTE_TMP}/artizo-relay.log`)} 2>&1 &`,
    `for i in $(seq 1 ${pollTicks}); do`,
    `  [ -f ${shQuote(portFile)} ] && cat ${shQuote(portFile)} && exit 0`,
    `  sleep 0.1`,
    `done`,
    `echo TIMEOUT >&2`,
    `exit 1`,
  ].join("; ");
  const spawn = await remoteExec(execServer, "sh", ["-c", spawnCmd], log);
  if (spawn.status !== 0) {
    return {
      kind: "error",
      message: `Relay daemon did not report a port within ${portFileTimeoutMs}ms (stderr: ${spawn.stderr || "none"})`,
    };
  }
  const port = parseInt(spawn.stdout.trim(), 10);
  if (!Number.isFinite(port) || port <= 0) {
    return {
      kind: "error",
      message: `Relay reported invalid port: ${JSON.stringify(spawn.stdout)}`,
    };
  }
  log(`[relay-heal] relay respawned on 127.0.0.1:${port}`);
  return { kind: "ok", relayPort: port };
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

/** Single-quote a path for safe shell interpolation. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
