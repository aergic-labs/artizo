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
 *   Windows client → ssh -L tunnel → SSH-host relay → docker exec → container
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
  /** Port the relay daemon is listening on (on the SSH host, 127.0.0.1). */
  relayPort: number;
  /** Connection token for the container's server-main.js. */
  connectionToken: string;
  /** Workspace path inside the container (e.g. /workspaces). */
  workspacePath: string;
  /**
   * Workspace path on the SSH host (e.g. /home/kerry/test-folder). Used by
   * "Reopen in Host" to reopen the SSH-remote folder, not the container.
   */
  hostWorkspacePath: string;
  /**
   * The full `ssh-remote+<hex>` authority for the SSH connection. Used by
   * "Reopen in Host" to reconstruct the SSH-remote workspace URI.
   */
  sshAuthority: string;
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

/** Idle timeout in ms (30 min). No connections → daemon exits. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Max consecutive docker exec failures before daemon exits. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Start the relay daemon on the SSH host.
 *
 * Writes a self-contained relay script to `/tmp/artizo-relay.mjs`, spawns it
 * detached with the given container connection info, waits for it to report
 * its chosen listen port, and returns the port + PID file.
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
  portFileTimeoutMs?: number;
}): Promise<RelayDaemonInfo> {
  const {
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    portFileTimeoutMs = 10_000,
  } = params;
  const log = getLogger();

  const scriptPath = path.join(os.tmpdir(), "artizo-relay.mjs");
  const pidFile = path.join(os.tmpdir(), `artizo-relay-${containerId}.pid`);
  const portFile = path.join(os.tmpdir(), `artizo-relay-${containerId}.port`);

  // Clean up stale PID/port files from a prior run.
  for (const f of [pidFile, portFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* doesn't exist, fine */
    }
  }

  // Write the relay script.
  const script = buildRelayScript({
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    pidFile,
    portFile,
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

  // Wait for the port file to appear (daemon writes it once listening).
  const relayPort = await waitForPortFile(portFile, portFileTimeoutMs);
  log.info(`[relay] daemon listening on 127.0.0.1:${relayPort}`);

  return { relayPort, pidFile, pid: child.pid };
}

/**
 * Kill a stale relay daemon by reading its PID file.
 * No-op if the PID file doesn't exist or the process is already dead.
 */
export function killStaleRelay(pidFile: string): void {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    return; // no PID file
  }
  if (!Number.isFinite(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
    getLogger().info(`[relay] killed stale daemon PID=${pid}`);
  } catch {
    /* already dead */
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* already gone */
  }
}

/**
 * Sweep stale relay daemon PID files in the OS temp dir and kill any whose
 * process is still alive but orphaned (e.g. from a crashed extension host).
 *
 * Called on activation when running workspace-side on an SSH host. Safe to
 * call any time: missing PID files are ignored, dead PIDs are no-ops, and
 * live PIDs that happen to belong to unrelated processes named differently
 * are left alone (we only kill PIDs whose PID file matches our naming
 * pattern `artizo-relay-<id>.pid`).
 *
 * @returns number of stale daemons killed (for logging).
 */
export function sweepStaleRelays(): number {
  const tmpDir = os.tmpdir();
  let killed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith("artizo-relay-") || !entry.endsWith(".pid")) continue;
    const pidFile = path.join(tmpDir, entry);
    killStaleRelay(pidFile);
    killed++;
  }
  if (killed > 0) {
    getLogger().info(`[relay] swept ${killed} stale relay daemon(s)`);
  }
  return killed;
}

/**
 * Decode an SSH remote authority (`ssh-remote+<hex>`) to extract host and user.
 *
 * The hex payload is a JSON object like `{"hostName":"34.136.190.14","user":"kerry"}`.
 * Returns undefined if the authority isn't an SSH remote or can't be decoded.
 */
export function decodeSshAuthority(
  remoteAuthority: string | undefined,
): { sshHost: string; sshUser: string } | undefined {
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
      };
      if (typeof parsed.hostName === "string") {
        const sshUser =
          typeof parsed.user === "string"
            ? parsed.user
            : os.userInfo().username;
        return { sshHost: parsed.hostName, sshUser };
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
  // Strip a trailing :port if present - the ssh target uses just the host.
  const colonIdx = hostPart.lastIndexOf(":");
  const sshHost = colonIdx >= 0 ? hostPart.substring(0, colonIdx) : hostPart;
  if (sshHost) return { sshHost, sshUser };

  return undefined;
}

// Relay script builder
/**
 * Wait for the daemon to write its chosen port to `portFile`.
 * Polls every 100ms up to `timeoutMs`. Throws on timeout.
 */
async function waitForPortFile(
  portFile: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(portFile, "utf-8").trim();
      const port = parseInt(content, 10);
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
 * 2. Writes the chosen port to `portFile` so the parent can read it.
 * 3. Writes its PID to `pidFile` for stale detection.
 * 4. For each accepted connection, spawns `docker exec -i <container>
 *    <nodePath> -e <tcpRelayScript>` and pipes bytes bidirectionally.
 * 5. Exits after `idleTimeoutMs` with no connections, or after
 *    `maxFailures` consecutive docker exec failures.
 */
function buildRelayScript(params: {
  containerId: string;
  containerPort: number;
  nodePath: string;
  dockerPath: string;
  pidFile: string;
  portFile: string;
  idleTimeoutMs: number;
  maxFailures: number;
}): string {
  const {
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    pidFile,
    portFile,
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
const PORT_FILE = ${JSON.stringify(portFile)};
const IDLE_TIMEOUT_MS = ${idleTimeoutMs};
const MAX_FAILURES = ${maxFailures};

let consecutiveFailures = 0;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error("[relay] idle timeout, exiting");
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(PORT_FILE); } catch {}
}

// Write PID file.
fs.writeFileSync(PID_FILE, String(process.pid));

const server = net.createServer({ pauseOnConnect: true }, (socket) => {
  consecutiveFailures = 0; // connection arrived, reset failure count
  if (idleTimer) clearTimeout(idleTimer);

  const child = spawn(
    DOCKER_PATH,
    ["exec", "-i", CONTAINER_ID, NODE_PATH, "-e", RELAY_SCRIPT],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  socket.pipe(child.stdin);
  child.stdout.pipe(socket);

  const done = () => {
    try { child.kill("SIGTERM"); } catch {}
    try { socket.destroy(); } catch {}
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
  fs.writeFileSync(PORT_FILE, String(port));
  console.log("[relay] listening on 127.0.0.1:" + port);
  resetIdleTimer();
});

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", () => { cleanup(); });
`;
}
