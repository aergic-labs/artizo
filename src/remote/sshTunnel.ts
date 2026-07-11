/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SSH port-forward tunnel transport for State 4 (RemoteSSHDevContainer).
 *
 * Spawns `ssh -L <localPort>:127.0.0.1:<remotePort> <user>@<host> -N` as a
 * long-lived child process on the apex host (Windows/macOS). The tunnel
 * forwards TCP bytes from the apex host's loopback to the SSH host's
 * relay daemon (Phase 1). The VS Code remote protocol is a pure byte stream,
 * so the tunnel doesn't parse anything - it's just a pipe.
 *
 * Branding: `ssh -E <logPath>` writes ssh's own log to a branded path, making
 * the process identifiable in `ps` / Activity Monitor / Task Manager as an
 * Artizo-managed process.
 *
 * Lifecycle:
 * - Spawned by the resolver when a bare `artizo-container+<hex>` authority
 *   with a proxy payload is resolved.
 * - `ServerAliveInterval=15` + `ServerAliveCountMax=4` keep the tunnel alive
 *   across transient network issues.
 * - `ExitOnForwardFailure=yes` makes ssh exit immediately if the `-L` binding
 *   fails (port in use) - the resolver can then retry with a new port.
 * - Tied to the apex host's extension host lifetime. Dies when the container
 *   window closes.
 * - Phase 5 hardening will add a health sentinel that respawns the tunnel if
 *   it dies (e.g. OS sleep / network change).
 *
 * See `plans/remaining-work.md` Phase 3.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import { SleepDetector } from "../health/sleepDetector";
import {
  batchModeArgs,
  sshEnvForAskpass,
  type AskpassHandle,
} from "../ssh/askpass";

/** Result of starting the SSH tunnel. */
export interface TunnelInfo {
  /** The local port on the apex host that's listening and forwarding. */
  localPort: number;
  /** The ssh child process (for lifecycle management / cleanup). */
  process: ChildProcess;
}

/**
 * Controller for a managed SSH tunnel. Wraps `TunnelInfo` with health-sentinel
 * logic: if the `ssh -L` child process dies unexpectedly (Windows sleep,
 * network change, SSH server restart), the controller respawns it with
 * exponential backoff until `stop()` is called.
 *
 * Created by `startManagedSshTunnel()`. The controller owns the `localPort`
 * for its lifetime - VS Code connects to that port, so the port must stay
 * stable across respawns (we rebind the same local port).
 */
export interface TunnelController {
  /** The local port VS Code was told to connect to. Stable across respawns. */
  localPort: number;
  /** Stop the tunnel and prevent respawn. Idempotent. */
  stop(): void;
  /** Whether the underlying ssh process is currently alive. */
  isAlive(): boolean;
}

/** Max respawn backoff (cap). 30s - past this, the user has noticed. */
const MAX_BACKOFF_MS = 30_000;
/** Initial respawn delay. */
const INITIAL_BACKOFF_MS = 1_000;
/** Debounce window for sleep/focus-initiated respawns. */
const MIN_RESPAWN_GAP_MS = 15_000;

/**
 * Resolve the SSH binary to use for the tunnel.
 *
 * Resolution order (see plan decision 6):
 *   1. `artizo.sshPath` setting (user override - not yet implemented, will
 *      come from vscode.workspace.getConfiguration)
 *   2. `C:\Windows\System32\OpenSSH\ssh.exe` if it exists (Windows OpenSSH,
 *      preferred - native agent, native config, no MSYS path translation)
 *   3. `ssh` from PATH (last resort - works on macOS/Linux, and on Windows
 *      if OpenSSH isn't in the standard location)
 *
 * Note: `C:\Windows\System32\OpenSSH\ssh.exe` has NO spaces in the path.
 * The earlier concern about spaces was a confusion with Git's path
 * (`C:\Program Files\Git\usr\bin\ssh.exe`).
 */
export function resolveSshBinary(): string {
  // 1. Explicit override via the `artizo.sshPath` setting. Wrapped in
  //    try/catch because resolveSshBinary may run before the workspace
  //    configuration is available in some activation paths.
  try {
    const configured = vscode.workspace
      .getConfiguration("artizo")
      .get<string>("sshPath");
    if (configured && configured.trim()) {
      return configured.trim();
    }
  } catch {
    /* config unavailable; fall through to auto-detection */
  }

  // 2. Windows OpenSSH (preferred on Windows)
  if (process.platform === "win32") {
    const winOpenSsh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
    try {
      if (fs.existsSync(winOpenSsh)) {
        return winOpenSsh;
      }
    } catch {
      /* ignore */
    }
  }

  // 3. PATH (macOS, Linux, Windows fallback)
  return "ssh";
}

/**
 * Start an SSH port-forward tunnel from the apex host to the SSH host.
 *
 * Spawns: `ssh -L <localPort>:127.0.0.1:<remotePort> <user>@<host> -N
 *   -E <logPath> -o ServerAliveInterval=15 -o ServerAliveCountMax=4
 *   -o ExitOnForwardFailure=yes`
 *
 * Waits for the local port to be listening before returning.
 *
 * @param params.sshHost   - SSH host IP or hostname
 * @param params.sshUser   - SSH user
 * @param params.remotePort - Port on the SSH host's loopback (relay daemon)
 * @param params.localPort  - Port on the apex host's loopback (picked by caller)
 */
export async function startSshTunnel(params: {
  sshHost: string;
  sshUser: string;
  remotePort: number;
  localPort: number;
  /** Askpass handle. When undefined, ssh runs with BatchMode=yes. */
  askpass?: AskpassHandle;
}): Promise<TunnelInfo> {
  const { sshHost, sshUser, remotePort, localPort, askpass } = params;
  const log = getLogger();

  const sshBinary = resolveSshBinary();
  const logDir = path.join(os.homedir(), ".artizo", "logs");
  const logPath = path.join(logDir, "ssh-helper.log");

  // Ensure log directory exists.
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* may already exist or no permission - ssh -E will fail gracefully */
  }

  const args = [
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    ...batchModeArgs(!!askpass),
    `${sshUser}@${sshHost}`,
    "-N",
    "-E",
    logPath,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "TCPKeepAlive=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];

  log.info(`[tunnel] spawning: ${sshBinary} ${args.join(" ")}`);

  const child = spawn(sshBinary, args, {
    stdio: ["ignore", "ignore", "pipe"], // stderr for error diagnostics
    detached: false, // tied to extension host lifetime
    env: sshEnvForAskpass(askpass),
  });

  // Capture stderr for debugging (ssh -E logs to file, but stderr may
  // still have critical errors).
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      log.info(`[tunnel] ssh stderr: ${text}`);
    }
  });

  child.on("error", (err) => {
    log.info(`[tunnel] ssh process error: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    log.info(`[tunnel] ssh exited code=${code} signal=${signal}`);
  });

  // Wait for the local port to be listening. ssh -L opens the listener
  // early, but ExitOnForwardFailure means it exits if the binding fails.
  // When askpass is active, the user may need time to respond to a
  // password prompt before ssh can connect and bind the port. No timeout
  // in that case; the window just waits for input. Without askpass, 10s
  // catches real bind failures (port in use, etc).
  const portWaitMs = askpass ? 0 : 10_000;
  await waitForLocalPort(localPort, portWaitMs);
  log.info(`[tunnel] local port ${localPort} is listening`);

  return { localPort, process: child };
}

/**
 * Stop an SSH tunnel by killing the child process.
 */
export function stopSshTunnel(tunnel: TunnelInfo): void {
  try {
    tunnel.process.kill("SIGTERM");
    getLogger().info("[tunnel] killed ssh process");
  } catch {
    /* already dead */
  }
}

/**
 * Pick a free TCP port on the apex host's loopback.
 * Uses the OS by binding to port 0 and immediately closing.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Wait for a local TCP port to be listening.
 * Polls by attempting a connection every 100ms. timeoutMs of 0 means
 * no timeout (wait indefinitely).
 */
async function waitForLocalPort(
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  while (deadline === 0 || Date.now() < deadline) {
    const reachable = await probePort(port);
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `SSH tunnel did not start listening on port ${port} within ${timeoutMs}ms`,
  );
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
    // Short timeout so we don't hang
    socket.setTimeout(500);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Start a managed SSH tunnel with health-sentinel respawn and EADDRINUSE retry.
 *
 * This is the production entry point for the State 4 resolver. It:
 *   1. Picks a free local port.
 *   2. Starts `ssh -L`. If the binding fails (`ExitOnForwardFailure=yes` causes
 *      ssh to exit immediately), picks a new port and retries - up to
 *      `maxBindRetries` times. This handles the rare race where another
 *      process grabs our port between `pickFreePort()` and ssh binding it.
 *   3. Monitors the ssh process. If it dies unexpectedly (not via `stop()`),
 *      respawns it with exponential backoff (1s → 2s → 4s → ... capped at 30s).
 *      The local port is reused across respawns so VS Code's connection stays
 *      valid.
 *
 * The returned `TunnelController` owns the port for its lifetime. Call
 * `stop()` to tear down and prevent respawn (wired into resolver `dispose()`).
 */
export async function startManagedSshTunnel(params: {
  sshHost: string;
  sshUser: string;
  remotePort: number;
  /** Max attempts to find a free local port if ssh -L fails to bind. */
  maxBindRetries?: number;
  /** Askpass handle for password/passphrase prompts. */
  askpass?: AskpassHandle;
}): Promise<TunnelController> {
  const { sshHost, sshUser, remotePort, askpass } = params;
  const maxBindRetries = params.maxBindRetries ?? 3;
  const log = getLogger();

  // Try to start the tunnel, retrying with a new port if the bind fails.
  // `ExitOnForwardFailure=yes` makes ssh exit immediately on bind failure, so
  // `startSshTunnel` rejects and we catch it here.
  let localPort: number | undefined;
  let tunnel: TunnelInfo | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxBindRetries; attempt++) {
    const candidatePort = await pickFreePort();
    try {
      tunnel = await startSshTunnel({
        sshHost,
        sshUser,
        remotePort,
        localPort: candidatePort,
        askpass,
      });
      localPort = candidatePort;
      break;
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      log.info(
        `[tunnel] bind attempt ${attempt + 1}/${maxBindRetries} on port ${candidatePort} failed: ${msg}`,
      );
    }
  }
  if (!tunnel || localPort === undefined) {
    throw new Error(
      `SSH tunnel failed to bind after ${maxBindRetries} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  const port = localPort;
  let current = tunnel;
  let stopped = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let respawnTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRespawn = (): void => {
    if (stopped) return;
    if (respawnTimer) return; // already scheduled
    log.info(`[tunnel] scheduling respawn in ${backoffMs}ms`);
    respawnTimer = setTimeout(async () => {
      respawnTimer = undefined;
      if (stopped) return;
      respawnInFlight = true;
      try {
        const respawned = await startSshTunnel({
          sshHost,
          sshUser,
          remotePort,
          localPort: port,
          askpass,
        });
        current = respawned;
        backoffMs = INITIAL_BACKOFF_MS; // reset on success
        attachSentinel(respawned);
        log.info(`[tunnel] respawned on port ${port}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.info(`[tunnel] respawn failed: ${msg}`);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        scheduleRespawn();
      } finally {
        respawnInFlight = false;
      }
    }, backoffMs);
  };

  /**
   * Attach the exit-sentinel to a tunnel's ssh process. On unexpected exit,
   * schedule a respawn with exponential backoff. The local port is reused
   * across respawns so VS Code's connection target stays stable.
   */
  const attachSentinel = (info: TunnelInfo): void => {
    info.process.on("exit", (code, signal) => {
      if (stopped) return;
      log.info(
        `[tunnel] ssh exited unexpectedly code=${code} signal=${signal}; will respawn`,
      );
      scheduleRespawn();
    });
  };

  attachSentinel(current);

  // Sleep/wake monitoring: on wake, proactively kill the tunnel so the
  // sentinel fires immediately instead of waiting for keepalive timeout.
  // Debounce prevents sleep + sentinel from both scheduling respawns.
  const detector = new SleepDetector();
  let lastRespawnAt = 0;
  let respawnInFlight = false;

  /** Trigger respawn with debounce + in-flight dedup. */
  const triggerWakeRespawn = (reason: string): void => {
    if (stopped) return;
    if (respawnTimer || respawnInFlight) {
      log.info(
        `[tunnel] ${reason}: respawn already scheduled/in-flight, skipping`,
      );
      return;
    }
    const now = Date.now();
    if (now - lastRespawnAt < MIN_RESPAWN_GAP_MS) {
      log.info(
        `[tunnel] ${reason}: debounced (last respawn ${now - lastRespawnAt}ms ago)`,
      );
      return;
    }
    lastRespawnAt = now;

    // Kill the tunnel so the sentinel fires immediately.
    log.info(`[tunnel] ${reason}: proactively killing tunnel for fast respawn`);
    try {
      current.process.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  };

  // Primary: timer-gap sleep detection.
  detector.onSleep((sleptMs) => {
    const sleptSec = Math.round(sleptMs / 1000);
    log.info(
      `[tunnel] sleep detected (~${sleptSec}s), triggering fast respawn`,
    );
    triggerWakeRespawn(`sleep(${sleptSec}s)`);
  });
  detector.start();

  // Secondary: focus regain + gap confirmation (faster than the timer).
  const focusDisposable = vscode.window.onDidChangeWindowState((state) => {
    if (!state.focused) return;
    if (stopped) return;
    if (!detector.isSleepingByGap()) return;
    const gap = detector.currentGap();
    log.info(
      `[tunnel] focus regain with gap=${Math.round(gap / 1000)}s, treating as wake`,
    );
    triggerWakeRespawn("focus-wake");
  });

  return {
    localPort: port,
    isAlive: () =>
      !stopped && current.process.exitCode === null && !current.process.killed,
    stop(): void {
      if (stopped) return;
      stopped = true;
      detector.stop();
      focusDisposable.dispose();
      if (respawnTimer) {
        clearTimeout(respawnTimer);
        respawnTimer = undefined;
      }
      try {
        current.process.kill("SIGTERM");
        log.info("[tunnel] stopped managed tunnel");
      } catch {
        /* already dead */
      }
    },
  };
}
