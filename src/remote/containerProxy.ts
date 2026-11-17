/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Apex-side relay daemon launcher for devcontainer-over-SSH.
 *
 * The relay runs on the SSH host and bridges the apex to the container's
 * server. It listens on `127.0.0.1:<port>` (TCP) and, per connection, spawns
 * `docker exec -i <container> <nodePath> -e <inner>` to pipe bytes to the
 * container's `server-main.js`. It replaces the apex's first PersistentProtocol
 * auth frame with the container's real connection token, read from
 * `<installPath>/connection-token` on every connection.
 *
 * The relay is spawned through the ExecServer (the standard remote contract),
 * not a local `child_process`. The apex reads the relay's port from its meta
 * file and reaches it with `tcpConnect("127.0.0.1", port)`.
 *
 * Lifecycle:
 * - PID file at `/tmp/.artizo/relays/<hash>.pid` for stale detection.
 * - Meta file at `/tmp/.artizo/relays/<hash>.meta.json` for the apex heal path.
 * - Idle timeout: exits after 30 min with no connections.
 * - Container-down: exits after 5 consecutive `docker exec` failures.
 */

import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { getLogger } from "../utils/logger";
import type { ExecServer } from "./execServerBridge";

/**
 * Fields that make up a workspace's stable identity in devcontainer-over-SSH.
 * The relay's meta and pid paths are derived from these; nothing volatile
 * belongs here.
 */
export interface StableWorkspaceIdentity {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  hostWorkspacePath: string;
  workspacePath: string;
}

/**
 * Canonical JSON for the stable identity. Both the apex (which spawns the
 * relay) and the resolver (which connects to it) hash this exact string, so
 * the key order is fixed.
 */
export function canonicalIdentityJSON(
  identity: StableWorkspaceIdentity,
): string {
  return JSON.stringify({
    sshHost: identity.sshHost,
    sshUser: identity.sshUser,
    sshPort: identity.sshPort,
    hostWorkspacePath: identity.hostWorkspacePath,
    workspacePath: identity.workspacePath,
  });
}

function identityHash(identity: StableWorkspaceIdentity): string {
  return createHash("sha256")
    .update(canonicalIdentityJSON(identity))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Fixed POSIX base for relay files. Must be identical on the SSH host and the
 * apex: the apex reads the meta file and connects to the port, so it cannot
 * depend on either machine's home directory.
 */
const RELAY_DIR = "/tmp/.artizo/relays";

/** Heal-info file the relay writes, keyed by the same stable hash. */
export function stableMetaPath(identity: StableWorkspaceIdentity): string {
  return path.posix.join(RELAY_DIR, `${identityHash(identity)}.meta.json`);
}

/** PID file the relay writes, keyed by the same stable hash. */
export function stablePidPath(identity: StableWorkspaceIdentity): string {
  return path.posix.join(RELAY_DIR, `${identityHash(identity)}.pid`);
}

/** Result of starting the relay daemon. */
export interface RelayDaemonInfo {
  /** TCP port the relay is listening on (on the SSH host, 127.0.0.1). */
  port: number;
  /** Meta file path the relay maintains for the apex heal path. */
  metaFile: string;
  /** PID file path (for stale detection / cleanup). */
  pidFile: string;
}

/** Idle timeout in ms (30 min). No connections -> daemon exits. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Max consecutive docker exec failures before daemon exits. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Heal info the relay writes at startup. */
export interface RelayMeta {
  /** SSH-host node that launched the relay. */
  hostNodePath?: string;
  /** Node binary inside the container. */
  nodePath?: string;
  /** Docker container ID. */
  containerId?: string;
  /** Port server-main.js listens on inside the container. */
  containerPort?: number;
  /** Docker binary path on the SSH host. */
  dockerPath?: string;
  /** TCP port the relay is listening on. */
  port?: number;
  /** Daemon bundle hash the relay was started with. */
  daemonHash?: string;
  /** Log file the relay writes to. */
  logFile?: string;
}

/**
 * Start the relay daemon on the SSH host through the ExecServer.
 *
 * Writes the bundled relay script to `/tmp/artizo-relay.cjs`, spawns it with
 * the SSH host's node, waits for the meta file to report a port, and returns
 * the port plus the meta and pid paths.
 *
 * The daemon writes `{nodePath, installPath, dockerPath, port, daemonHash,
 * logFile, containerId, containerPort}` to its meta file so the apex-side
 * `healRelay` can re-spawn it. The meta file is NOT cleaned up by the daemon -
 * it must survive idle timeout, SIGTERM, SIGKILL, and remote reboot so a later
 * reload can read it. Only the PID file is cleaned up (the PID file is the
 * stale-detection signal).
 *
 * @param params.execServer         - ExecServer for the SSH host
 * @param params.hostNodePath       - SSH-host node binary that runs the relay
 * @param params.logFile            - Relay log file on the SSH host
 * @param params.containerId        - Docker container ID
 * @param params.containerPort      - Port server-main.js listens on inside the container
 * @param params.nodePath           - Full path to node binary inside the container
 * @param params.dockerPath         - Docker binary path (on the SSH host)
 * @param params.identity           - Stable identity; keys the meta + pid paths
 * @param params.timeoutMs          - Max wait for the relay to report a port
 * @param params.relayScriptPath    - Override for the bundled daemon (tests)
 * @param params.relayScriptTargetPath - Override for the daemon copy (tests)
 */
export async function startRelayDaemon(params: {
  execServer: ExecServer;
  hostNodePath: string;
  logFile: string;
  containerId: string;
  containerPort: number;
  nodePath: string;
  dockerPath: string;
  identity: StableWorkspaceIdentity;
  timeoutMs?: number;
  relayScriptPath?: string;
  relayScriptTargetPath?: string;
}): Promise<RelayDaemonInfo> {
  const {
    execServer,
    hostNodePath,
    logFile,
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    identity,
    timeoutMs = 10_000,
  } = params;
  const log = getLogger();

  const remoteFs = execServer.fs;
  // ExecServer methods are class methods on the other side; calling a
  // destructured reference loses `this`.
  const spawn = execServer.spawn?.bind(execServer);
  if (!remoteFs || !spawn) {
    throw new Error("ExecServer is missing fs or spawn; cannot start relay");
  }

  const metaFile = stableMetaPath(identity);
  const pidFile = stablePidPath(identity);

  const daemonSource = await readLocalDaemon(params.relayScriptPath);
  const daemonHash = createHash("sha256")
    .update(daemonSource)
    .digest("hex")
    .slice(0, 16);

  // Reuse a live relay only when it runs the current daemon. A relay from an
  // older build would keep serving stale code after an extension update.
  const existing = await readRelayMeta(execServer, metaFile);
  if (
    existing?.daemonHash === daemonHash &&
    typeof existing.port === "number" &&
    existing.port > 0 &&
    (await isRelayLive(execServer, existing.port))
  ) {
    log.info(`[relay] reusing live daemon on 127.0.0.1:${existing.port}`);
    return { port: existing.port, metaFile, pidFile };
  }
  if (existing) {
    log.info(
      `[relay] replacing stale daemon (meta=${existing.daemonHash ?? "none"} current=${daemonHash})`,
    );
  }

  await rmQuiet(remoteFs, metaFile);
  await rmQuiet(remoteFs, pidFile);

  const scriptPath = params.relayScriptTargetPath ?? "/tmp/artizo-relay.cjs";
  await remoteFs.mkdirp(path.posix.dirname(scriptPath));
  const writer = await remoteFs.write(scriptPath);
  writer.stream.write(new Uint8Array(daemonSource));
  writer.stream.end();
  await writer.done;
  log.info(`[relay] wrote relay daemon to ${scriptPath}`);

  const config = {
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    port: 0,
    pidFile,
    metaFile,
    hostNodePath,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    maxFailures: MAX_CONSECUTIVE_FAILURES,
    logFile,
    spawnedBy: "extension",
    daemonHash,
  };

  const spawned = await spawn(hostNodePath, [
    scriptPath,
    JSON.stringify(config),
  ]);
  // Drain the streams so the transport doesn't buffer them. The relay logs to
  // its own file, so these are normally empty.
  spawned.stdout.onDidReceiveMessage(() => {});
  spawned.stderr.onDidReceiveMessage(() => {});
  let exitStatus: number | undefined;
  void spawned.onExit
    .then((e) => {
      exitStatus = e.status;
    })
    .catch(() => {});

  const port = await waitForRelayPort(
    execServer,
    metaFile,
    timeoutMs,
    () => exitStatus,
  );
  log.info(`[relay] daemon listening on 127.0.0.1:${port}`);
  return { port, metaFile, pidFile };
}

/** Read the bundled relay daemon source. */
async function readLocalDaemon(override?: string): Promise<Buffer> {
  const fs = await import("node:fs/promises");
  return fs.readFile(override ?? defaultRelayScriptPath());
}

/**
 * Read and parse the relay's meta file. Returns undefined when the file is
 * missing or unparseable.
 */
export async function readRelayMeta(
  execServer: ExecServer,
  metaFile: string,
): Promise<RelayMeta | undefined> {
  const remoteFs = execServer.fs;
  if (!remoteFs) return undefined;
  try {
    const stream = await remoteFs.read(metaFile);
    const chunks: Uint8Array[] = [];
    stream.onDidReceiveMessage((d) => chunks.push(d));
    await stream.onEnd;
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as RelayMeta;
  } catch {
    return undefined;
  }
}

/** True when something is accepting connections on `127.0.0.1:port`. */
export async function isRelayLive(
  execServer: ExecServer,
  port: number,
): Promise<boolean> {
  try {
    const { stream, done } = await execServer.tcpConnect("127.0.0.1", port);
    try {
      stream.end();
    } catch {
      /* best effort */
    }
    void done.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function rmQuiet(
  remoteFs: NonNullable<ExecServer["fs"]>,
  p: string,
): Promise<void> {
  try {
    await remoteFs.rm(p);
  } catch {
    /* missing */
  }
}

/**
 * Poll the meta file until the relay reports a port. Throws on timeout or if
 * the spawned process exits non-zero first.
 */
async function waitForRelayPort(
  execServer: ExecServer,
  metaFile: string,
  timeoutMs: number,
  getExitStatus: () => number | undefined,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getExitStatus();
    if (status !== undefined && status !== 0) {
      throw new Error(`Relay daemon exited with status ${status}`);
    }
    const meta = await readRelayMeta(execServer, metaFile);
    if (meta && typeof meta.port === "number" && meta.port > 0) {
      return meta.port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Relay daemon did not write a port to ${metaFile} within ${timeoutMs}ms`,
  );
}

/**
 * Bundled daemon path. The extension runs as CJS (`__dirname` is set); tests
 * import this module as ESM and pass `relayScriptPath` explicitly.
 */
function defaultRelayScriptPath(): string {
  if (typeof __dirname !== "undefined") {
    return path.join(__dirname, "..", "relay-daemon.cjs");
  }
  return path.join(process.cwd(), "dist", "relay-daemon.cjs");
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