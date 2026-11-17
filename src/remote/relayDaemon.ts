/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Standalone relay daemon for devcontainer-over-SSH.
 *
 * Runs on the SSH host's bundled Node, detached from the extension host.
 * Listens on `127.0.0.1:<port>` and, per connection, spawns `docker exec -i
 * <container> <node> -e <inner>` to pipe bytes to the container's
 * `server-main.js`. It is a dumb byte pipe: the apex passes the connection
 * token, so no frame rewriting happens here.
 *
 * Bundled separately as `dist/relay-daemon.cjs` and launched with a JSON
 * config as `argv[2]`. No vscode imports.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import { spawn } from "node:child_process";

export interface RelayConfig {
  /** Docker container ID on the SSH host. */
  containerId: string;
  /** Port server-main.js listens on inside the container. */
  containerPort: number;
  /** Node binary inside the container. */
  nodePath: string;
  /** Docker binary path on the SSH host. */
  dockerPath: string;
  /** TCP port to listen on. 0 picks an ephemeral port. */
  port: number;
  pidFile: string;
  metaFile: string;
  /** SSH-host node that launched the relay. */
  hostNodePath: string;
  idleTimeoutMs: number;
  maxFailures: number;
  /** File the daemon appends its log to. */
  logFile: string;
  /** Who started this daemon. */
  spawnedBy: "extension" | "heal";
  /** Hash of the daemon bundle; the extension reuses a relay only on match. */
  daemonHash: string;
}

const PORT_PLACEHOLDER = "__ARTIZO_PORT__";
const INNER_TEMPLATE = `const n=require("net"),c=n.createConnection(${PORT_PLACEHOLDER},"127.0.0.1",()=>{process.stdin.pipe(c);c.pipe(process.stdout);process.stdin.resume()});c.on("error",()=>process.exit(1));c.on("close",()=>process.exit(0));process.stdin.on("close",()=>process.exit(0))`;

export function startRelay(config: RelayConfig): void {
  const {
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    port,
    pidFile,
    metaFile,
    hostNodePath,
    idleTimeoutMs,
    maxFailures,
    logFile,
    spawnedBy,
    daemonHash,
  } = config;

  const log = (msg: string): void => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      /* logging must never break the relay */
    }
  };

  log(
    `start spawnedBy=${spawnedBy} daemonHash=${daemonHash} container=${containerId} containerPort=${containerPort} nodePath=${nodePath} dockerPath=${dockerPath} port=${port} logFile=${logFile}`,
  );

  process.title = "artizo-remote-ssh-helper";

  let consecutiveFailures = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let activeConnections = 0;

  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log("idle timeout, exiting");
      process.exit(0);
    }, idleTimeoutMs);
  };

  // Only the PID file is removed. The meta file must survive idle timeout,
  // SIGTERM, SIGKILL and reboot so the apex can re-spawn the relay.
  const cleanup = (): void => {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
  };

  const inner = INNER_TEMPLATE.replace(PORT_PLACEHOLDER, String(containerPort));

  let connCounter = 0;
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    const connId = ++connCounter;
    const clog = (msg: string): void => log(`[${connId}] ${msg}`);
    clog("connection accepted");
    consecutiveFailures = 0;
    activeConnections++;
    if (idleTimer) clearTimeout(idleTimer);

    clog(`spawning docker exec container=${containerId} node=${nodePath}`);
    const child = spawn(
      dockerPath,
      ["exec", "-i", containerId, nodePath, "-e", inner],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      activeConnections--;
      if (activeConnections <= 0) resetIdleTimer();
    };

    socket.on("close", done);
    socket.on("error", done);

    child.stdin?.on("error", () => {
      /* client went away */
    });
    child.on("error", (err) => {
      log(`child error: ${err.message}`);
      done();
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        consecutiveFailures++;
        log(`docker exec exit code=${code} failures=${consecutiveFailures}`);
        if (consecutiveFailures >= maxFailures) {
          log("max failures reached, exiting");
          cleanup();
          process.exit(1);
        }
      }
      done();
    });

    if (child.stdin) socket.pipe(child.stdin);
    if (child.stdout) child.stdout.pipe(socket);
    socket.resume();
  });

  server.on("error", (err) => {
    log(`server error: ${err.message}`);
    cleanup();
    process.exit(1);
  });

  let boundPort = 0;
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    boundPort = typeof addr === "object" && addr ? addr.port : port;
    fs.writeFileSync(pidFile, String(process.pid));
    try {
      fs.writeFileSync(
        metaFile,
        JSON.stringify({
          hostNodePath,
          nodePath,
          containerId,
          containerPort,
          dockerPath,
          port: boundPort,
          daemonHash,
          logFile,
        }),
      );
    } catch (err) {
      log(
        `meta write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log(`listening on 127.0.0.1:${boundPort}`);
    resetIdleTimer();
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", () => {
    cleanup();
  });
}

/** Env flag marking the detached daemon copy. */
export const RELAY_DAEMON_ENV = "ARTIZO_RELAY_DAEMON";

/**
 * Re-exec a detached copy of the daemon. `ExecServer.spawn` has no detach, so
 * the spawned process is the launcher; `detached: true` (POSIX `setsid()`)
 * makes the copy its own session, so it outlives the transport. Returns the
 * child and an accessor for the async spawn error; the caller exits.
 */
export function launchDetachedDaemon(config: RelayConfig): {
  child: ReturnType<typeof spawn>;
  getError: () => Error | undefined;
} {
  let spawnError: Error | undefined;
  const child = spawn(
    process.execPath,
    [process.argv[1], JSON.stringify(config)],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [RELAY_DAEMON_ENV]: "1" },
    },
  );
  child.on("error", (err: Error) => {
    spawnError = err;
  });
  child.unref();
  return { child, getError: () => spawnError };
}

// Entry point when run as a script (the bundled CJS daemon). Importing this
// module from tests must not start anything.
if (typeof require !== "undefined" && require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    console.error("[relay] missing config argument");
    process.exit(2);
  }
  let config: RelayConfig;
  try {
    config = JSON.parse(raw) as RelayConfig;
  } catch (err) {
    console.error(
      `[relay] invalid config: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  if (process.env[RELAY_DAEMON_ENV] === "1") {
    startRelay(config);
  } else {
    const { getError } = launchDetachedDaemon(config);
    // Give the async spawn error event a tick before exiting.
    setImmediate(() => {
      const err = getError();
      if (err) {
        console.error(`[relay] launcher spawn failed: ${err.message}`);
        process.exit(1);
      }
      process.exit(0);
    });
  }
}