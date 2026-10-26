/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Workspace-side relay daemon for State 4 (RemoteSSHDevContainer).
 *
 * When the extension is running workspace-side on an SSH host and the user
 * triggers "reopen in container", this module starts a **detached** TCP relay
 * daemon on the SSH host. The relay listens on `127.0.0.1:<port>` and, for
 * each accepted connection, spawns `docker exec -i <container> <nodePath> -e
 * <tcpRelayScript>` to pipe bytes to the container's `server-main.js`.
 *
 * The daemon is detached (`child_process.spawn` with `detached: true`,
 * `stdio: 'ignore'`, `unref()`) so it outlives the SSH-remote window's
 * extension host. The container window (opened on Windows) reaches the relay
 * through an `ssh -L` tunnel (Phase 3) and the byte stream flows:
 *
 *   Windows client -> ssh -L tunnel -> SSH-host relay -> docker exec -> container
 *
 * Lifecycle:
 * - PID file at `/tmp/artizo-relay-<containerId>.pid` for stale detection.
 * - Idle timeout: exits after 30 min with no connections.
 * - Container-down: exits after 5 consecutive `docker exec` failures.
 *
 * See `plans/remaining-work.md` Phase 1.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "../utils/logger";
import { tcpRelayScript } from "../utils/dockerUtils";

/** Info needed by the Windows-side resolver to start the ssh -L tunnel. */
export interface ProxyAuthorityInfo {
  /** Discriminator: always `true` for proxy payloads. */
  proxy: true;
  /** SSH host IP or hostname. */
  sshHost: string;
  /** SSH user. */
  sshUser: string;
  /** SSH port (default 22 when not specified by the authority). */
  sshPort: number;
  /** Port the relay daemon is listening on (on the SSH host, 127.0.0.1). */
  relayPort: number;
  /** Connection token for the container's server-main.js. */
  connectionToken: string;
  /** Workspace path inside the container (e.g. /workspaces). */
  workspacePath: string;
  /**
   * Workspace path on the SSH host. Used by "Reopen in Host" to reopen
   * the SSH-remote folder, not the container.
   */
  hostWorkspacePath: string;
  /**
   * The full `ssh-remote+<hex>` authority for the SSH connection. Used by
   * "Reopen in Host" to reconstruct the SSH-remote workspace URI.
   */
  sshAuthority: string;
  /**
   * Docker container ID on the SSH host. Optional (older payloads lack it).
   * When present, the apex can re-spawn the relay daemon on reload if the
   * cached `relayPort` is no longer reachable.
   */
  containerId?: string;
  /**
   * Port `server-main.js` listens on inside the container. Optional. Needed
   * only by the apex-side relay heal path.
   */
  containerPort?: number;
  /**
   * Server install path inside the container. The relay invokes
   * `<installPath>/node` to exec into the container. Optional.
   */
  installPath?: string;
}

/** Result of starting the relay daemon. */
export interface RelayDaemonInfo {
  /** Port the relay is listening on. */
  relayPort: number;
  /** PID file path (for stale detection / cleanup). */
  pidFile: string;
  /** PID of the daemon process. */
  pid: number;
}

/** Idle timeout in ms (30 min). No connections -> daemon exits. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Max consecutive docker exec failures before daemon exits. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Start the relay daemon on the SSH host.
 *
 * Writes a self-contained relay script to `/tmp/artizo-relay.mjs`, spawns it
 * detached with the given container connection info, waits for it to report
 * its chosen listen port, and returns the port + PID file.
 *
 * The daemon also writes a `.meta.json` file beside the PID file holding
 * `{port, nodePath}` so the apex-side `healRelay` can re-spawn the relay
 * using the exact node binary that launched it (the SSH host's bundled
 * node is not on PATH). The meta file is NOT cleaned up by the daemon -
 * it must survive idle timeout, SIGTERM, SIGKILL, and remote reboot so a
 * later reload can read it. Only the PID file is cleaned up (it's the
 * stale-detection signal).
 *
 * @param params.containerId  - Docker container ID
 * @param params.containerPort - Port server-main.js is listening on inside the container
 * @param params.nodePath     - Full path to node binary inside the container
 * @param params.dockerPath   - Docker binary path (on the SSH host)
 */
export async function startRelayDaemon(params: {
  containerId: string;
  containerPort: number;
  nodePath: string;
  dockerPath: string;
  /** Timeout in ms to wait for the daemon to report its port. Default 10s. */
  metaFileTimeoutMs?: number;
}): Promise<RelayDaemonInfo> {
  const {
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    metaFileTimeoutMs = 10_000,
  } = params;
  const log = getLogger();

  const scriptPath = path.join(os.tmpdir(), "artizo-relay.mjs");
  const pidFile = path.join(os.tmpdir(), `artizo-relay-${containerId}.pid`);
  const metaFile = path.join(os.tmpdir(), `artizo-relay-${containerId}.meta.json`);

  // Clean up stale PID file from a prior run. The meta file is intentionally
  // left in place: if a prior daemon is dead, its PID file is gone but the
  // meta file may still hold a valid nodePath the apex can reuse. We unlink
  // it before writing a fresh one below so we don't read stale port info.
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* doesn't exist, fine */
  }
  try {
    fs.unlinkSync(metaFile);
  } catch {
    /* doesn't exist, fine */
  }

  // Write the relay script. Pass `process.execPath` (the node binary running
  // this extension host) as `hostNodePath` so the daemon records it in the
  // meta file for the apex-side heal path. The SSH host's bundled node is
  // not on PATH, so a bare `node` would fail to re-spawn.
  const script = buildRelayScript({
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    pidFile,
    metaFile,
    hostNodePath: process.execPath,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    maxFailures: MAX_CONSECUTIVE_FAILURES,
  });
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  log.info(`[relay] wrote relay script to ${scriptPath}`);

  // Pre-spawn diagnostics: confirm the node binary we're about to invoke
  // actually exists and is executable. If it doesn't, spawn() would fail
  // synchronously with pid=undefined and we'd only see "no PID" otherwise.
  try {
    fs.accessSync(process.execPath, fs.constants.X_OK);
    log.info(`[relay] execPath OK: ${process.execPath}`);
  } catch (accessErr) {
    log.info(
      `[relay] execPath ACCESS FAILED: ${process.execPath} -> ${accessErr instanceof Error ? accessErr.message : String(accessErr)}`,
    );
  }
  try {
    fs.accessSync(os.tmpdir(), fs.constants.W_OK);
  } catch (tmpErr) {
    log.info(
      `[relay] tmpdir ACCESS FAILED: ${os.tmpdir()} -> ${tmpErr instanceof Error ? tmpErr.message : String(tmpErr)}`,
    );
  }

  // Spawn detached. stdio ignored so the process is fully independent.
  // Use process.execPath (the node binary running this extension host)
  // instead of a bare "node" - the SSH host's server bundles its own node
  // but doesn't necessarily put it on the extension host's PATH.
  //
  // Attach an `error` listener *before* checking `pid`: when spawn() fails
  // synchronously (ENOENT/EACCES), `child.pid` is undefined AND an `error`
  // event is queued asynchronously. Without the listener the real cause is
  // swallowed (Node throws an unhandled error later) and we'd only see the
  // generic "no PID" symptom. We race the error event against a brief tick
  // so callers see the actual underlying message.
  let spawnError: Error | undefined;
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: "ignore",
    cwd: os.tmpdir(),
  });
  child.on("error", (err: Error) => {
    spawnError = err;
  });
  child.unref();

  log.info(
    `[relay] spawned daemon PID=${child.pid ?? "unknown"} execPath=${process.execPath}`,
  );
  if (!child.pid) {
    // Yield once so the async `error` event has a chance to fire and populate
    // spawnError before we report. Without this we'd lose the real cause.
    await new Promise((r) => setImmediate(r));
    if (spawnError) {
      throw new Error(
        `Failed to spawn relay daemon: ${spawnError.message} (execPath=${process.execPath})`,
      );
    }
    throw new Error(
      `Failed to spawn relay daemon: no PID (execPath=${process.execPath})`,
    );
  }

  // Wait for the meta file to appear (daemon writes it once listening).
  try {
    const relayPort = await waitForMetaFile(metaFile, metaFileTimeoutMs);
    log.info(`[relay] daemon listening on 127.0.0.1:${relayPort}`);
    return { relayPort, pidFile, pid: child.pid };
  } catch (err) {
    // Daemon failed to report a port. Kill the detached child so we don't
    // leave an orphaned `artizo-remote-ssh-helper` (it has a 30-min idle
    // timeout, but that's a long time to hold the container connection).
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
    throw err;
  }
}

/**
 * Decode an SSH remote authority (`ssh-remote+<hex>`) to extract host and user.
 *
 * The hex payload is a JSON object like `{"hostName":"34.136.190.14","user":"dev"}`.
 * Returns undefined if the authority isn't an SSH remote or can't be decoded.
 */
export function decodeSshAuthority(
  remoteAuthority: string | undefined,
): { sshHost: string; sshUser: string; sshPort: number } | undefined {
  if (!remoteAuthority) return undefined;
  const plusIdx = remoteAuthority.indexOf("+");
  if (plusIdx === -1) return undefined;
  const scheme = remoteAuthority.substring(0, plusIdx);
  if (!scheme.startsWith("ssh-remote")) return undefined;

  const rest = remoteAuthority.substring(plusIdx + 1).trimStart();

  // Form 1: hex-encoded JSON (e.g. {"hostName":"...","user":"...","port":...}).
  try {
    const json = Buffer.from(rest, "hex").toString("utf-8");
    // Only treat as hex-JSON if the decoded content looks like a JSON object;
    // otherwise plain IPv4/hostname segments (digits and a-f) can decode
    // to a valid JSON primitive and shadow the plain-form path.
    if (json.startsWith("{")) {
      const parsed = JSON.parse(json) as {
        hostName?: unknown;
        user?: unknown;
        port?: unknown;
      };
      if (typeof parsed.hostName === "string") {
        const sshUser =
          typeof parsed.user === "string"
            ? parsed.user
            : os.userInfo().username;
        const sshPort =
          typeof parsed.port === "number" && parsed.port > 0
            ? parsed.port
            : 22;
        return { sshHost: parsed.hostName, sshUser, sshPort };
      }
      return undefined;
    }
  } catch {
    // Not hex-JSON; fall through to the plain form.
  }

  // Form 2: plain `user@host:port`, `host:port`, `user@host`, or `host`.
  // VS Code lowercases the authority, so uppercase letters are escaped as
  // `\xNN` and must be unescaped before parsing.
  const unescaped = rest.replace(/\\x([0-9a-f]{2})/g, (_, ch) =>
    String.fromCharCode(parseInt(ch, 16)),
  );
  const atIdx = unescaped.lastIndexOf("@");
  const hostPart = atIdx >= 0 ? unescaped.substring(atIdx + 1) : unescaped;
  const sshUser =
    atIdx >= 0 ? unescaped.substring(0, atIdx) : os.userInfo().username;
  // Strip a trailing :port if present - ssh gets -p <port> separately.
  const colonIdx = hostPart.lastIndexOf(":");
  const sshHost = colonIdx >= 0 ? hostPart.substring(0, colonIdx) : hostPart;
  let sshPort = 22;
  if (colonIdx >= 0) {
    const portStr = hostPart.substring(colonIdx + 1);
    if (/^\d+$/.test(portStr)) sshPort = Number(portStr);
  }
  if (sshHost) return { sshHost, sshUser, sshPort };

  return undefined;
}

// Relay script builder
/**
 * Wait for the daemon to write its chosen port + nodePath to `metaFile`.
 * Polls every 100ms up to `timeoutMs`. Throws on timeout.
 */
async function waitForMetaFile(
  metaFile: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(metaFile, "utf-8").trim();
      const parsed = JSON.parse(content) as { port?: unknown };
      const port = Number(parsed.port);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay daemon did not report a port within ${timeoutMs}ms`);
}

/**
 * Build the self-contained relay daemon script.
 *
 * The script is a standalone ESM node file that:
 * 1. Listens on 127.0.0.1:0 (ephemeral port).
 * 2. Writes JSON `{port, nodePath}` to `metaFile` so the parent (and the
 *    apex-side healRelay after this daemon dies) can read both the port
 *    and the host node binary path. The meta file is NOT cleaned up on
 *    exit - it must survive idle timeout, SIGTERM, SIGKILL, and remote
 *    reboot so healRelay can re-spawn the relay with the same node binary.
 * 3. Writes its PID to `pidFile` for stale detection (cleaned up on exit).
 * 4. For each accepted connection, spawns `docker exec -i <container>
 *    <nodePath> -e <tcpRelayScript>` and pipes bytes bidirectionally.
 * 5. Exits after `idleTimeoutMs` with no connections, or after
 *    `maxFailures` consecutive docker exec failures.
 */
export function buildRelayScript(params: {
  containerId: string;
  containerPort: number;
  nodePath: string;
  dockerPath: string;
  pidFile: string;
  /** Path to the JSON meta file the daemon writes {port, nodePath} to. */
  metaFile: string;
  /**
   * Full path to the node binary that launched the daemon (process.execPath
   * on the workspace side). Recorded in the meta file so the apex-side
   * healRelay can re-spawn the relay with the same node after the daemon dies.
   */
  hostNodePath: string;
  idleTimeoutMs: number;
  maxFailures: number;
}): string {
  const {
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    pidFile,
    metaFile,
    hostNodePath,
    idleTimeoutMs,
    maxFailures,
  } = params;

  // The tcpRelayScript connects to containerPort inside the container.
  const relayScript = tcpRelayScript(containerPort);

  // The relay script is a string - we need to escape it for embedding.
  const relayScriptJson = JSON.stringify(relayScript);

  return `/*
 * Artizo relay daemon - auto-generated by containerProxy.ts.
 * Listens on 127.0.0.1, relays TCP to a docker container's server-main.js.
 * Detached: outlives the extension host that spawned it.
 */
// Brand the process so it's identifiable in ps / Activity Monitor / Task Manager.
process.title = "artizo-remote-ssh-helper";

import * as net from "node:net";
import * as fs from "node:fs";
import { spawn } from "node:child_process";

const CONTAINER_ID = ${JSON.stringify(containerId)};
const NODE_PATH = ${JSON.stringify(nodePath)};
const DOCKER_PATH = ${JSON.stringify(dockerPath)};
const RELAY_SCRIPT = ${relayScriptJson};
const PID_FILE = ${JSON.stringify(pidFile)};
const META_FILE = ${JSON.stringify(metaFile)};
const HOST_NODE_PATH = ${JSON.stringify(hostNodePath)};
const IDLE_TIMEOUT_MS = ${idleTimeoutMs};
const MAX_FAILURES = ${maxFailures};

let consecutiveFailures = 0;
let idleTimer = null;
let activeConnections = 0;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error("[relay] idle timeout, exiting");
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

// cleanup() only removes the PID file. The meta file is intentionally left
// in place so the apex-side healRelay can read nodePath and re-spawn the
// relay after this daemon dies (idle timeout, SIGTERM, SIGKILL, reboot).
function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// Write PID file.
fs.writeFileSync(PID_FILE, String(process.pid));

const server = net.createServer({ pauseOnConnect: true }, (socket) => {
  consecutiveFailures = 0; // connection arrived, reset failure count
  activeConnections++;
  if (idleTimer) clearTimeout(idleTimer);

  const child = spawn(
    DOCKER_PATH,
    ["exec", "-i", CONTAINER_ID, NODE_PATH, "-e", RELAY_SCRIPT],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  socket.pipe(child.stdin);
  child.stdout.pipe(socket);

  // done() runs once per connection (socket close/error and child error/exit
  // all call it). When the last connection ends, re-arm the idle timer so the
  // daemon can still exit after being idle - it was only cleared on connect.
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    try { child.kill("SIGTERM"); } catch {}
    try { socket.destroy(); } catch {}
    activeConnections--;
    if (activeConnections <= 0) resetIdleTimer();
  };

  socket.on("close", done);
  socket.on("error", done);
  child.on("error", (e) => {
    console.error("[relay] child error: " + e.message);
    done();
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      consecutiveFailures++;
      console.error("[relay] docker exec exit code=" + code + " failures=" + consecutiveFailures);
      if (consecutiveFailures >= MAX_FAILURES) {
        console.error("[relay] max failures reached, exiting");
        cleanup();
        process.exit(1);
      }
    }
    done();
  });

  socket.resume();
});

server.on("error", (e) => {
  console.error("[relay] server error: " + e.message);
  cleanup();
  process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // Write JSON meta: the apex reads {port, nodePath} on heal. We deliberately
  // do NOT unlink this on exit - it has to survive SIGTERM/SIGKILL/idle/reboot
  // so healRelay can re-spawn the relay using HOST_NODE_PATH.
  fs.writeFileSync(META_FILE, JSON.stringify({ port, nodePath: HOST_NODE_PATH }));
  console.log("[relay] listening on 127.0.0.1:" + port);
  resetIdleTimer();
});

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", () => { cleanup(); });
`;
}
